-- 0002: clear the content signature of every job whose description is blank.
--
-- WHY: the old signer hashed title + description, so a posting with a blank description was signed by its
-- title alone, and unrelated postings that share a title read as duplicates of each other. The digest shows
-- one job per signature, so the others were hidden. Since #88 the signer returns NULL for a blank
-- description (signatureSql in src/repos/sql.ts), but only for rows ingest writes or edits after the deploy;
-- rows signed before it keep their title-only signature until their text changes, which for a blank
-- description is rarely.
--
-- WHAT IT CHANGES: jobs.content_signature -> NULL where it is set and description_text has no non-space
-- character. That is exactly what signatureSql computes for those rows today (a guard below checks it). No
-- other column changes: title, description and embedding stay as they are.
--
-- EXPECTED EFFECT (preview 2026-10-12): 799 rows (355 active, 444 closed). 114 of them sat in 47 false
-- duplicate groups (largest 7); among active jobs 33 rows in 15 groups, one of which joined three companies'
-- "Data Engineer" postings. No job with a real description shares a signature with these rows, so nothing
-- else ungroups. Re-running changes nothing.
--
-- DEPLOY ORDER: apply after the scrapers Worker runs the #88 signer (deploy first), so no tick re-signs one
-- of these rows title-only afterwards.

/* preview (read-only)

-- Rows the fix clears, by state. Expect 799 in total (355 active, 444 closed) on 2026-10-12.
SELECT lifecycle_state, count(*)
FROM jobs
WHERE content_signature IS NOT NULL AND description_text !~ '[^[:space:]]'
GROUP BY 1;

-- Jobs WITH a description that share a signature with those rows. Expect 0.
SELECT count(*)
FROM jobs j
WHERE j.description_text ~ '[^[:space:]]'
  AND j.content_signature IN (
    SELECT content_signature FROM jobs
    WHERE content_signature IS NOT NULL AND description_text !~ '[^[:space:]]');

-- The false duplicate groups among them. Expect 47 groups, 114 rows, largest 7.
SELECT count(*) AS groups, sum(n) AS rows_in_groups, max(n) AS biggest
FROM (
  SELECT content_signature, count(*) AS n
  FROM jobs
  WHERE content_signature IS NOT NULL AND description_text !~ '[^[:space:]]'
  GROUP BY 1
  HAVING count(*) > 1
) g;
*/

DO $$
DECLARE
  target int;
  cleared int;
BEGIN
  SELECT count(*) INTO target
  FROM jobs
  WHERE content_signature IS NOT NULL AND description_text !~ '[^[:space:]]';
  -- Guard: the preview found 799. Far more means the data isn't what it showed.
  IF target > 2000 THEN
    RAISE EXCEPTION '% jobs match (bound 2000)', target;
  END IF;

  -- Guard: NULL must be what the application's signer computes for these rows (signatureSql: md5 of the
  -- normalized title + newline + description, NULL when that equals the normalized title alone).
  IF EXISTS (
    SELECT 1
    FROM jobs
    WHERE content_signature IS NOT NULL
      AND description_text !~ '[^[:space:]]'
      AND md5(NULLIF(
            btrim(regexp_replace(lower(title || chr(10) || description_text), '[[:space:]]+', ' ', 'g')),
            btrim(regexp_replace(lower(title), '[[:space:]]+', ' ', 'g')))) IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'the signer would not return NULL for every matched row';
  END IF;

  UPDATE jobs
  SET content_signature = NULL
  WHERE content_signature IS NOT NULL AND description_text !~ '[^[:space:]]';
  GET DIAGNOSTICS cleared = ROW_COUNT;
  RAISE NOTICE 'cleared the title-only signature of % jobs', cleared;
END $$;
