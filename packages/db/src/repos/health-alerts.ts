/**
 * Phase H1b — the first writer + reader of `health_alerts` (the F6-reserved migration 0014 table;
 * `schema.ts`). Two small primitives over the append-only event log that together give page-once-per-
 * cooldown dedup:
 *   - {@link recordHealthAlert}: insert ONE row for a firing check that actually paged.
 *   - {@link shouldNotify}: `true` iff NO prior row for this check within the cooldown window.
 * The caller (the `pnpm health` CLI and the scheduled Inngest fn) gates on `shouldNotify` first and only
 * records when it actually sends, so a row means "paged recently" → the next run suppresses. Both paths
 * share these two primitives so the manual and scheduled runs dedup identically.
 *
 * Shape-only (the F6 no-secrets/PII invariant): `check_id`/`mode` + numeric `metric`/`threshold` mirror a
 * {@link HealthCheck}, and `detail` is a shape-only line the caller renders (an age/ratio/count, never job
 * or user text). Pure Neon reads/writes — no env/console/Date. The alert ORCHESTRATION (filter → notify →
 * send email → record) lives in `@opusfinder/inngest` (Node, where the email seam is); this is DB-only so
 * it stays Worker-forward and out of the email/env import graph.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../client";
import { healthAlerts } from "../schema";
import { resultRows } from "./sql";

/** Default re-page cooldown (hours); env `HEALTH_ALERT_COOLDOWN_H` overrides at the call site. A firing
 *  check pages at most once per this window, so a persistently-firing check pages once/day, not every run
 *  (PHASE_H1_PLAN.md decision 5). */
export const DEFAULT_HEALTH_ALERT_COOLDOWN_H = 24;

/**
 * The shape-only fields {@link recordHealthAlert} persists — a structural subset of a `HealthCheck`
 * (`id`/`mode` + numeric `metric`/`threshold`). Declared LOCALLY, NOT imported from `../health`, on
 * purpose: this repo is reachable from the scraper Worker's compile graph (via `@opusfinder/db/repos`),
 * and `health.ts` references `process` (in `healthOptionsFromEnv`), which would break the Worker's
 * deliberately node-types-free typecheck. A `HealthCheck` is structurally assignable to this.
 */
export interface HealthAlertInput {
  id: string;
  mode: string;
  metric: number | null;
  threshold: number | null;
}

/**
 * Insert ONE append-only event row for a firing check. `detail` is a shape-only line (the rendered
 * metric/threshold, never job/user text) supplied by the caller. `metric`/`threshold` ride through as-is
 * (nullable `real`). Append-only: no update, no delete (G3g's `pruneOplog` bounds the row count by age).
 */
export async function recordHealthAlert(db: Db, check: HealthAlertInput, detail: string): Promise<void> {
  await db.insert(healthAlerts).values({
    checkId: check.id,
    mode: check.mode,
    metric: check.metric,
    threshold: check.threshold,
    detail,
  });
}

/**
 * `true` iff NO `health_alerts` row exists for `checkId` within the last `cooldownH` hours — i.e. it is
 * clear to page again. The window binds as a param (`${n} * interval '1 hour'`, the retrieval.ts /
 * prune-oplog.ts idiom). Because a row is written ONLY when the caller actually pages, a recent row means
 * "paged within the window" → return `false` to suppress the re-page. A 0 (or sub-0) cooldown degenerates
 * to `created_at > now()` (no past row qualifies) → always clear to page, which is the right behaviour for
 * an operator who has explicitly disabled the cooldown.
 */
export async function shouldNotify(db: Db, checkId: string, cooldownH: number): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM health_alerts
    WHERE check_id = ${checkId} AND created_at > now() - ${cooldownH} * interval '1 hour'
  `);
  const n = Number((resultRows(r)[0] as { n?: number } | undefined)?.n ?? 0);
  return n === 0;
}
