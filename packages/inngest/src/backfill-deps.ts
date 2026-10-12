/**
 * Build the production backfill deps: a neon-http db + the real Voyage `embed`. NODE/server-only (reaches
 * Voyage + reads env via `/env`; `guard:worker` keeps `@opusfinder/inngest` out of the scraper bundle).
 * Keys are read LAZILY at first network call, so the serve process boots without them (an unconfigured drain
 * fails loudly on its first page). Kept OUT of the package barrel for the same Node-only reason.
 */
import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { embed, EmbeddingRejectedError } from "@opusfinder/embeddings";
import { NonRetriableError } from "inngest";

import type { BackfillDeps } from "./backfill";

export function buildBackfillDeps(): BackfillDeps {
  return {
    db: createDb(getDatabaseUrl()),
    // A rejected page fails identically on every retry, and each retry re-pays the page's earlier
    // requests, so end the run instead (the next daily run starts over).
    embed: async (texts, params) => {
      try {
        return await embed(texts, params);
      } catch (err) {
        if (err instanceof EmbeddingRejectedError) {
          throw new NonRetriableError(err.message, { cause: err });
        }
        throw err;
      }
    },
  };
}
