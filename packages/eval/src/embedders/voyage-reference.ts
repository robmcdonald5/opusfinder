import { EMBED_DIMENSIONS, EMBED_MODEL } from "@opusfinder/embeddings";
import { embed } from "@opusfinder/embeddings/node";

import { possiblyBilled, type SnapshotModel } from "./snapshot-models";

/**
 * The snapshot's reference: production's own `embed()`, so a reference vector is what production
 * retrieval would have stored for the same text (same model, width and document/query prompting).
 * The limits are production's per-request bounds, so `embed()` sends each batch as one request and
 * the usage it returns is that request's.
 */
export const voyageReference: SnapshotModel = {
  id: EMBED_MODEL,
  slug: "voyage-4-large",
  role: "reference",
  host: "api.voyageai.com",
  dimensions: EMBED_DIMENSIONS,
  // List price. The account's first 200M tokens are free, so real spend may be lower; the spend
  // guard counts the list price.
  pricePerMTokUsd: 0.12,
  limits: { maxItems: 128, maxTokens: 90_000, charsPerToken: 3 },
  presentation: {
    document: 'input_type "document" (Voyage prepends its own document prompt)',
    query: 'input_type "query" (Voyage prepends its own query prompt)',
  },
  async embedBatch(texts, inputType) {
    try {
      const res = await embed(texts, { inputType });
      return { embeddings: res.embeddings, totalTokens: res.usage.totalTokens };
    } catch (err) {
      // Voyage refusing with an error status, or a connection that never opened, bills nothing. A
      // timeout or an answer that failed production's checks may have been billed.
      const refused =
        err instanceof Error && /^Voyage embeddings request failed: \d{3}/.test(err.message);
      throw refused || err instanceof TypeError ? err : possiblyBilled(err);
    }
  },
};
