-- 0003: give the closed jobs that have no close date the one migration 0018's backfill gave the rest.
--
-- WHY: the jobs prune deletes a closed job once its closed_at is more than 30 days old, and treats a NULL
-- closed_at as never old enough. Migration 0018 added closed_at and backfilled it from updated_at for the jobs
-- closed at the time; jobs closed by the older code between that backfill and the deploy that stamps closed_at
-- kept NULL. Every close path stamps closed_at now, so no new ones appear, but these can never be pruned.
--
-- WHAT IT CHANGES: jobs.closed_at -> updated_at where lifecycle_state = 'closed' and closed_at IS NULL, the
-- same rule as 0018. updated_at is the row's last write: the close itself, or a later write to the closed row,
-- which only makes the date later and the prune more conservative. No other column changes.
--
-- EXPECTED EFFECT (preview 2026-10-18): 3,005 rows, all embedded. 2,995 were last written the week of
-- 2026-06-15 (when closing went live) and 10 on 2026-10-08. 8 of them are in digest_items, which the prune
-- never deletes. The other ~2,997 become prunable the next time it runs. Re-running changes nothing.

/* preview (read-only)

-- The rows the fix dates. Expect 3005, 2995 older than 30 days, none with a NULL updated_at.
SELECT count(*),
       min(updated_at),
       max(updated_at),
       count(*) FILTER (WHERE updated_at < now() - interval '30 days') AS older_than_30d,
       count(*) FILTER (WHERE updated_at IS NULL) AS null_updated
FROM jobs
WHERE lifecycle_state = 'closed' AND closed_at IS NULL;

-- The invariant the other half of the rule relies on: no active job carries a close date. Expect 0.
SELECT count(*) FROM jobs WHERE lifecycle_state = 'active' AND closed_at IS NOT NULL;
*/

DO $$
DECLARE
  target int;
  dated int;
BEGIN
  SELECT count(*) INTO target
  FROM jobs
  WHERE lifecycle_state = 'closed' AND closed_at IS NULL;
  -- Guard: the preview found 3,005, and nothing creates more. Far more means the data isn't what it showed.
  IF target > 3500 THEN
    RAISE EXCEPTION '% undated closed jobs match (bound 3500)', target;
  END IF;

  UPDATE jobs
  SET closed_at = updated_at
  WHERE lifecycle_state = 'closed' AND closed_at IS NULL;
  GET DIAGNOSTICS dated = ROW_COUNT;
  RAISE NOTICE 'dated % closed jobs that had no close date', dated;
END $$;
