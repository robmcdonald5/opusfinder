-- The job prune's rule, in one place: a closed job is deleted once it has been closed for 30 days, if no digest
-- ever showed it. SECURITY DEFINER, so the scrapers Worker's login (which holds no DELETE) runs the weekly prune
-- through this function and nothing else; worker-role:setup grants it EXECUTE. `pnpm db:prune` calls it too, so
-- the script and the Worker can't disagree on what is prunable.
--
-- apply = false counts the prunable rows. apply = true deletes up to max_rows of them (at most 5000 per call) and
-- returns how many it deleted. The rule repeats on the DELETE itself: under READ COMMITTED a row revived after the
-- batch was read is re-checked against the DELETE's own WHERE and kept.
--
-- ROLLOUT: apply BEFORE re-running worker-role:setup (it grants EXECUTE on this) and before deploying the Worker.
CREATE OR REPLACE FUNCTION public.prune_closed_jobs(max_rows integer, apply boolean)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF NOT apply THEN
    SELECT count(*) INTO n FROM public.jobs j
    WHERE j.lifecycle_state = 'closed'
      AND j.closed_at < now() - interval '30 days'
      AND j.id NOT IN (SELECT di.job_id FROM public.digest_items di);
    RETURN n;
  END IF;
  DELETE FROM public.jobs j
  WHERE j.id IN (
      SELECT c.id FROM public.jobs c
      WHERE c.lifecycle_state = 'closed'
        AND c.closed_at < now() - interval '30 days'
        AND c.id NOT IN (SELECT di.job_id FROM public.digest_items di)
      ORDER BY c.id
      LIMIT least(greatest(coalesce(max_rows, 0), 0), 5000)
    )
    AND j.lifecycle_state = 'closed'
    AND j.closed_at < now() - interval '30 days'
    AND j.id NOT IN (SELECT di.job_id FROM public.digest_items di);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prune_closed_jobs(integer, boolean) FROM PUBLIC;
