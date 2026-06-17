/**
 * Build the production F8 backfill deps: a neon-http db + the real Voyage `embed`. NODE/server-only — it
 * reaches Voyage (`@opusfinder/embeddings`) and reads env via the `/env` subpaths; the serve route + the dev
 * serve script call it. Never reached from a Worker (`guard:worker` keeps `@opusfinder/inngest` out of the
 * scraper bundle). Keys (`VOYAGE_API_KEY` / `DATABASE_URL`) are read LAZILY at first network call, so the
 * serve process boots without them (an unconfigured drain then fails loudly on its first page). Mirrors
 * `buildDigestDeps()` (./deps); kept OUT of the package barrel for the same reason (Node-only).
 */
import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { embed } from "@opusfinder/embeddings";

import type { BackfillDeps } from "./backfill";

export function buildBackfillDeps(): BackfillDeps {
  return {
    db: createDb(getDatabaseUrl()),
    embed,
  };
}
