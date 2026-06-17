/**
 * The operator / dev-panel health DATA route (Phase-12 12a-4). Returns the F6 `checkHealth` report over a
 * neon-http db — NO new logic (checkHealth is pure/serverless-safe by F6 design). Node serverless (reads
 * DATABASE_URL + HEALTH_* env). The db is built INSIDE the handler (request time), so the build-time route
 * analysis never reads env — no lazy wrapper needed.
 *
 * Status: 200 when healthy, 503 when `report.unhealthy` (an enforce-mode check is firing) — so a plain
 * uptime ping surfaces enforce firings WITHOUT a token and without parsing JSON. By default every check is
 * `shadow` (unhealthy=false) until the owner sets HEALTH_ENFORCE, so this returns 200 until checks are
 * deliberately promoted.
 *
 * ACCESS (12a hardening): the FULL report is shape-only (counts / ages / ratios — no secrets/PII, an F6
 * invariant) but still leaks operational intelligence (backlog sizes, a user-count proxy via the
 * bounce/suppressed counts, staleness ages) on a public URL. So the full body is gated behind
 * HEALTH_PING_TOKEN (Authorization: `Bearer <token>` or `?token=<token>`); an anonymous / wrong-token
 * caller gets only the minimal `{ unhealthy }` body — enough for an uptime monitor, nothing for recon.
 * When HEALTH_PING_TOKEN is UNSET the route is secure-by-default (minimal body for everyone); set the token
 * to read the full report at the URL, or use `pnpm health` (DB-direct) for full detail without exposing it.
 * 12b's dev panel replaces this with the Better Auth owner gate.
 */
import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { checkHealth, healthOptionsFromEnv } from "@opusfinder/db/health";
import { json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

/** True only when HEALTH_PING_TOKEN is set AND the caller presents it (bearer header or ?token=). */
function isAuthorized(request: Request, url: URL): boolean {
  const expected = process.env.HEALTH_PING_TOKEN;
  if (!expected) return false; // unset → nobody is authorized for the full body (secure default)
  const bearer = request.headers.get("authorization");
  const presented = bearer?.startsWith("Bearer ") ? bearer.slice(7) : url.searchParams.get("token");
  return presented === expected;
}

export const GET: RequestHandler = async ({ request, url }) => {
  const db = createDb(getDatabaseUrl());
  const report = await checkHealth(db, healthOptionsFromEnv());
  const status = report.unhealthy ? 503 : 200;
  // The 200/503 status (the uptime signal) is returned to EVERYONE; only the detailed body is gated.
  const body = isAuthorized(request, url) ? report : { unhealthy: report.unhealthy };
  return json(body, { status });
};
