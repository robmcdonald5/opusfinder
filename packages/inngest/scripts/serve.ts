/**
 * Local Inngest serve endpoint (dev-only). Exposes the non-cron functions over a bare Node http server so
 * the local dev server (`pnpm inngest:dev`) can discover + invoke them — no Inngest Cloud
 * account, no keys (run with INNGEST_DEV=1). The development driver only. Long-running — kill with Ctrl-C.
 */
import http from "node:http";

import { serve } from "inngest/node";

import { buildBackfillDeps } from "../src/backfill-deps.ts";
import { buildDigestDeps } from "../src/deps.ts";
import { buildHealthDeps } from "../src/health-deps.ts";
import { createAllFunctions, inngest } from "../src/index.ts";

// Port 3000 is PINNED: the root `inngest:dev` script registers this endpoint at
// http://localhost:3000/api/inngest with --no-discovery, so a port override here would silently
// de-register every digest function from the dev server. Change both together or neither.
const port = 3000;
// No crons: the dev server fires them on schedule and the Inngest Cloud pause doesn't reach it, so they
// would run against whatever DATABASE_URL and API keys the local .env files hold. `pnpm digest`,
// `pnpm embeddings:backfill` and `pnpm health` run the same work on demand.
const functions = createAllFunctions({
  digest: buildDigestDeps(),
  backfill: buildBackfillDeps(),
  health: buildHealthDeps(),
}).filter((fn) => !(fn.opts as { triggers?: object[] }).triggers?.some((t) => "cron" in t));
const handler = serve({ client: inngest, functions });

// Dev mode skips signature checks, so whatever reaches this port can run a function on forged step state.
// Loopback keeps other hosts out. Browsers send Origin on every cross-site POST and the dev server never
// does, so refusing it keeps a web page from driving the functions through localhost.
const server = http.createServer((req, res) => {
  if (req.headers.origin !== undefined) {
    res.writeHead(403).end();
    return;
  }
  handler(req, res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Inngest serve listening on http://localhost:${port}/api/inngest`);
  console.log(
    `INNGEST_DEV=${process.env.INNGEST_DEV ?? "(unset — set INNGEST_DEV=1 and run `pnpm inngest:dev`)"}`,
  );
});
