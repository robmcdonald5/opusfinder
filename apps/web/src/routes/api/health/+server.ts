/**
 * The operator / dev-panel health DATA route (Phase-12 12a-4). Returns the F6 `checkHealth` report as JSON
 * over a neon-http db — NO new logic (checkHealth is pure/serverless-safe by F6 design: it's the panel's
 * data path with no new API). Node serverless (reads DATABASE_URL + HEALTH_* env). The db is built INSIDE
 * the handler (request time), so the build-time route analysis never reads env — no lazy wrapper needed.
 *
 * Status: 200 when healthy, 503 when `report.unhealthy` (an enforce-mode check is firing) — so a plain
 * uptime ping on this URL surfaces enforce firings without parsing JSON; the body carries the full report
 * either way. By default every check is `shadow` (unhealthy=false) until the owner sets HEALTH_ENFORCE, so
 * this returns 200 until checks are deliberately promoted.
 *
 * UNAUTHENTICATED in 12a (headless, no UI). The report is shape-only (counts / ages / ratios — no
 * secrets/PII, an F6 invariant), so exposure is low-risk; 12b's dev panel adds the Better Auth owner gate.
 */
import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { checkHealth, healthOptionsFromEnv } from "@opusfinder/db/health";
import { json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  const db = createDb(getDatabaseUrl());
  const report = await checkHealth(db, healthOptionsFromEnv());
  return json(report, { status: report.unhealthy ? 503 : 200 });
};
