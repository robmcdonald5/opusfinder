/**
 * The PRODUCTION Inngest serve endpoint (Phase-12 12a) — the deployed counterpart of the dev-only
 * `scripts/serve.ts` in @opusfinder/inngest, swapped from `inngest/node` to `inngest/sveltekit`. It hosts
 * the Phase-10 digest functions + the F8 backfill drains + the H1b health-check alerter on Inngest Cloud,
 * served from SvelteKit-on-Vercel.
 *
 * Runtime: serverless NODE (not edge — the deps reach @anthropic-ai/sdk + @neondatabase/serverless);
 * maxDuration is set on the adapter (svelte.config.js). The Inngest Cloud keys (INNGEST_SIGNING_KEY /
 * INNGEST_EVENT_KEY) are read from the environment by the SDK itself — provisioned by the Inngest Vercel
 * integration; do NOT set them by hand, and leave INNGEST_DEV UNSET in production.
 *
 * The handler is built LAZILY (on first request), NOT at module load: SvelteKit's build-time route analysis
 * imports this module, and `buildDigestDeps()` / `buildBackfillDeps()` read DATABASE_URL + the API keys
 * (absent during the build). Deferring to the first request reads env at runtime (cold start), where Vercel
 * provides it; the handler is memoized per serverless instance.
 */
import {
  createBackfillFunctions,
  createDigestFunctions,
  createHealthFunctions,
  inngest,
} from "@opusfinder/inngest";
import { buildBackfillDeps } from "@opusfinder/inngest/backfill-deps";
import { buildDigestDeps } from "@opusfinder/inngest/deps";
import { buildHealthDeps } from "@opusfinder/inngest/health-deps";
import { serve } from "inngest/sveltekit";

import type { RequestHandler } from "./$types";

let handler: ReturnType<typeof serve> | undefined;

function getHandler(): ReturnType<typeof serve> {
  return (handler ??= serve({
    client: inngest,
    functions: [
      ...createDigestFunctions(buildDigestDeps()),
      ...createBackfillFunctions(buildBackfillDeps()),
      ...createHealthFunctions(buildHealthDeps()),
    ],
  }));
}

export const GET: RequestHandler = (event) => getHandler().GET(event);
export const POST: RequestHandler = (event) => getHandler().POST(event);
export const PUT: RequestHandler = (event) => getHandler().PUT(event);
