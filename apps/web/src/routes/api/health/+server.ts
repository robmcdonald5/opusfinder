/**
 * The operator / dev-panel health DATA route. Returns the `checkHealth` report over a neon-http db — NO
 * new logic (checkHealth is pure/serverless-safe). Node serverless (reads DATABASE_URL + HEALTH_* env).
 * The db is built INSIDE the handler (request time), so the build-time route analysis never reads env —
 * no lazy wrapper needed.
 *
 * Status: 200 when healthy, 503 when `report.unhealthy` (an enforce-mode check is firing) — so a plain
 * uptime ping surfaces enforce firings WITHOUT a token and without parsing JSON. By default every check is
 * `shadow` (unhealthy=false) until the owner sets HEALTH_ENFORCE, so this returns 200 until checks are
 * deliberately promoted.
 *
 * ACCESS: the FULL report is shape-only (counts / ages / ratios — no secrets/PII) but still leaks
 * operational intelligence (backlog sizes, a user-count proxy via the bounce/suppressed counts, staleness
 * ages) on a public URL. So the full body is gated behind HEALTH_PING_TOKEN (Authorization: `Bearer
 * <token>`); an anonymous / wrong-token caller gets only the minimal `{ unhealthy }` body. When
 * HEALTH_PING_TOKEN is UNSET the route is secure-by-default (minimal body for everyone); set the token to
 * read the full report at the URL, or use `pnpm health` (DB-direct) for full detail without exposing it.
 *
 * COST: a query wakes Neon, so public hits must not query per hit. Anonymous callers never query while no
 * check enforces (the answer is fixed); otherwise they share a per-instance answer refreshed at most every
 * 10 minutes, so an uptime monitor sees an enforce firing up to that late.
 */
import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { checkHealth, healthOptionsFromEnv, type HealthOptions } from "@opusfinder/db/health";
import { json } from "@sveltejs/kit";

import { isAuthorized } from "./auth";
import type { RequestHandler } from "./$types";

const PUBLIC_TTL_MS = 10 * 60_000;
let publicMemo: { at: number; unhealthy: boolean } | undefined;

async function publicUnhealthy(opts: HealthOptions): Promise<boolean> {
  // `unhealthy` can only come from an enforce-mode check (every unset check defaults to shadow).
  if (!Object.values(opts.modes ?? {}).includes("enforce")) return false;
  if (!publicMemo || Date.now() - publicMemo.at >= PUBLIC_TTL_MS) {
    const { unhealthy } = await checkHealth(createDb(getDatabaseUrl()), opts);
    publicMemo = { at: Date.now(), unhealthy };
  }
  return publicMemo.unhealthy;
}

export const GET: RequestHandler = async ({ request }) => {
  const opts = healthOptionsFromEnv();
  if (isAuthorized(request)) {
    const report = await checkHealth(createDb(getDatabaseUrl()), opts);
    return json(report, { status: report.unhealthy ? 503 : 200 });
  }
  // The 200/503 status (the uptime signal) is returned to EVERYONE; only the detailed body is gated.
  const unhealthy = await publicUnhealthy(opts);
  return json({ unhealthy }, { status: unhealthy ? 503 : 200 });
};
