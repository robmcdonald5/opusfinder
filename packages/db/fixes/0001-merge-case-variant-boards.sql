-- 0001: merge the 7 boards that exist as two case-variant company rows (SmartRecruiters 5, Ashby 2).
--
-- WHY: SmartRecruiters and Ashby match board ids case-INSENSITIVELY (verified live 2026-10-08: each pair below
-- lists identical postings), but `companies` is unique on the case-sensitive (slug, source), so discovery
-- created a second row for these boards. Each board is fetched twice per sweep, and its jobs' company_id flips
-- between the two rows on every fetch (upsertJobs points a posting at the board that listed it).
--
-- WHAT IT CHANGES, per pair, all in ONE transaction: every `jobs` row of the ALIAS company moves to the KEPT
-- company (company_id + updated_at, the same write ingest makes when it re-points a posting), then the alias
-- row is retired, so ingestion and discovery stop visiting it. Moving and retiring must not be split: ingest
-- fetches every ACTIVE company, and a fetch of a still-active alias moves its jobs straight back.
-- `retire` (the one-line switch below) picks how:
--   'delete'     (the owner's choice, 2026-10-08) removes the alias row. `jobs` is the only table with a foreign key to companies, and
--                the alias has no jobs left by then (the FK would refuse otherwise). Leaves no inactive case
--                variant for a discovery run to revive. digest_items keeps its own company_slug snapshot.
--   'deactivate' keeps the row with active = false (+ updated_at). Reversible by hand, but the inactive variant
--                stays in the table.
--
-- KEPT ROW = the provider's canonical spelling (checked 2026-10-08): SmartRecruiters `company.identifier` on the
-- postings API (BoschGroup, K-group1, McDonaldsCorporation, TheMill2) or the careers page's companyIdentifier
-- for Visa; Ashby's `hostedJobsPageSlug` on jobs.ashbyhq.com (Mapbox, Solace), which is also the casing Ashby
-- apply URLs echo back. Visa's board lists no postings today; it is merged anyway so the duplicate row can't
-- come back to life when the board fills.
--
-- EXPECTED EFFECT: the 7 alias rows gone (or inactive), all their jobs (any lifecycle_state) under the kept
-- rows; each board fetched once per sweep. Moved Ashby jobs keep their old-casing apply_url until the kept
-- board's next fetch rewrites it. Re-running changes nothing: a gone alias is skipped, an inactive one has no
-- jobs. If the apply lands while an ingest tick that already listed the alias is still running, that tick's
-- fetch of the alias board fails (deleted) or moves its jobs back until the kept board's next fetch (deactivated).
--
-- DEPLOY ORDER: deploy the discovery case-folding fix first, and before the Sunday 2026-10-11 03:00Z discovery
-- run. Without it, a discovery run that finds an alias spelling again inserts a fresh row (after a delete) or
-- probes it live and re-activates it (after a deactivate).

/* preview (read-only)

-- The 14 rows: identity, state and job counts. Expect every row active, slugs as in the apply list below.
SELECT c.id, c.source, c.slug, c.active,
       count(j.id) AS jobs,
       count(j.id) FILTER (WHERE j.lifecycle_state = 'active') AS active_jobs,
       count(j.id) FILTER (WHERE j.source <> c.source) AS other_source_jobs
FROM companies c
LEFT JOIN jobs j ON j.company_id = c.id
WHERE c.id IN (1420, 624, 576, 601, 1068, 1069, 309, 604, 10, 806, 1660, 814, 62710, 1546)
GROUP BY c.id
ORDER BY c.source, lower(c.slug), c.id;

-- Any OTHER row for the same 7 boards. Expect none: the apply aborts if one exists.
SELECT id, source, slug, active
FROM companies
WHERE (source, lower(slug)) IN (
        ('smartrecruiters', 'boschgroup'), ('smartrecruiters', 'k-group1'),
        ('smartrecruiters', 'mcdonaldscorporation'), ('smartrecruiters', 'themill2'),
        ('smartrecruiters', 'visa'), ('ashby', 'mapbox'), ('ashby', 'solace'))
  AND id NOT IN (1420, 624, 576, 601, 1068, 1069, 309, 604, 10, 806, 1660, 814, 62710, 1546);
*/

DO $$
DECLARE
  retire constant text := 'delete'; -- or 'deactivate' (see the header)
  p record;
  alias_row record;
  moved int;
  retired int;
  total_moved int := 0;
BEGIN
  IF retire NOT IN ('delete', 'deactivate') THEN
    RAISE EXCEPTION 'retire must be delete or deactivate, not %', retire;
  END IF;

  FOR p IN
    SELECT *
    FROM (VALUES
      ('smartrecruiters',  1420, 'BoschGroup',            624, 'boschgroup'),
      ('smartrecruiters',   576, 'K-group1',              601, 'k-group1'),
      ('smartrecruiters',  1068, 'McDonaldsCorporation', 1069, 'mcdonaldscorporation'),
      ('smartrecruiters',   309, 'TheMill2',              604, 'themill2'),
      ('smartrecruiters',    10, 'Visa',                  806, 'visa'),
      ('ashby',            1660, 'Mapbox',                814, 'mapbox'),
      ('ashby',           62710, 'Solace',               1546, 'solace')
    ) AS v (source, keep_id, keep_slug, alias_id, alias_slug)
  LOOP
    -- Guard the list itself: each pair must be two spellings of one slug.
    IF lower(p.keep_slug) <> lower(p.alias_slug) OR p.keep_slug = p.alias_slug THEN
      RAISE EXCEPTION 'bad pair %/%', p.keep_slug, p.alias_slug;
    END IF;
    -- Guard the kept row: same source + slug as the preview showed, still active. FOR UPDATE holds the rows
    -- until commit, so discovery can't change them mid-fix.
    PERFORM 1 FROM companies
    WHERE id = p.keep_id AND source = p.source AND slug = p.keep_slug AND active
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'kept row % (% %) is missing, changed or inactive', p.keep_id, p.source, p.keep_slug;
    END IF;
    -- Guard: the pair is the WHOLE group. A third spelling would be left behind.
    IF EXISTS (
      SELECT 1 FROM companies
      WHERE source = p.source AND lower(slug) = lower(p.keep_slug) AND id NOT IN (p.keep_id, p.alias_id)
    ) THEN
      RAISE EXCEPTION 'another % row spells % (not covered by this fix)', p.source, p.keep_slug;
    END IF;

    SELECT c.source, c.slug INTO alias_row FROM companies c WHERE c.id = p.alias_id FOR UPDATE;
    IF NOT FOUND THEN
      -- Already deleted (a re-run): jobs can't point at a missing row, so this pair is done.
      RAISE NOTICE '% %: alias row % (%) already gone', p.source, p.keep_slug, p.alias_id, p.alias_slug;
      CONTINUE;
    END IF;
    IF alias_row.source <> p.source OR alias_row.slug <> p.alias_slug THEN
      RAISE EXCEPTION 'alias row % is now % %, expected % %',
        p.alias_id, alias_row.source, alias_row.slug, p.source, p.alias_slug;
    END IF;
    -- Guard: an ingested posting always carries its board's source; anything else here is unexplained.
    IF EXISTS (SELECT 1 FROM jobs WHERE company_id = p.alias_id AND source <> p.source) THEN
      RAISE EXCEPTION 'alias row % has jobs from another source', p.alias_id;
    END IF;

    UPDATE jobs SET company_id = p.keep_id, updated_at = now() WHERE company_id = p.alias_id;
    GET DIAGNOSTICS moved = ROW_COUNT;
    -- Guard: the largest board here (BoschGroup) lists ~4.9k postings; far more means the data isn't what the
    -- preview showed.
    IF moved > 20000 THEN
      RAISE EXCEPTION 'alias row % would move % jobs (bound 20000)', p.alias_id, moved;
    END IF;

    IF retire = 'delete' THEN
      DELETE FROM companies WHERE id = p.alias_id;
    ELSE
      UPDATE companies SET active = false, updated_at = now() WHERE id = p.alias_id AND active;
    END IF;
    GET DIAGNOSTICS retired = ROW_COUNT;

    total_moved := total_moved + moved;
    RAISE NOTICE '% %: kept row %; alias row % (%): % jobs moved, % row %',
      p.source, p.keep_slug, p.keep_id, p.alias_id, p.alias_slug, moved, retired, retire || 'd';
  END LOOP;
  RAISE NOTICE 'total: % jobs moved', total_moved;
END $$;
