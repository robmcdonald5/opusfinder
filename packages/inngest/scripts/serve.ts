/**
 * Local Inngest serve endpoint (dev-only). Exposes the digest functions over a bare Node http server so
 * the local dev server (`npx inngest-cli@latest dev`) can discover + invoke them — no Inngest Cloud
 * account, no keys (run with INNGEST_DEV=1). The PRODUCTION serve endpoint (inngest/sveltekit on Vercel)
 * is a Phase-12 decision; this is the development driver only. Long-running — kill with Ctrl-C.
 */
import http from "node:http";

import { serve } from "inngest/node";

import { buildDigestDeps } from "../src/deps.ts";
import { createDigestFunctions, inngest } from "../src/index.ts";

// Port 3000 is PINNED: the root `inngest:dev` script registers this endpoint at
// http://localhost:3000/api/inngest with --no-discovery, so a port override here would silently
// de-register every digest function from the dev server. Change both together or neither.
const port = 3000;
const handler = serve({ client: inngest, functions: createDigestFunctions(buildDigestDeps()) });

http.createServer(handler).listen(port, () => {
  console.log(`Inngest serve listening on http://localhost:${port}/api/inngest`);
  console.log(
    `INNGEST_DEV=${process.env.INNGEST_DEV ?? "(unset — set INNGEST_DEV=1 and run `npx inngest-cli@latest dev`)"}`,
  );
});
