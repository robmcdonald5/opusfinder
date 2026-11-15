import { requireEnv } from "@opusfinder/shared/require-env";

/**
 * Read + validate VOYAGE_API_KEY from the ambient environment: the fallback for a call that passes no
 * `apiKey`. The soft "pa-" prefix check warns but never hard-fails (prefixes can change; the provider
 * is the real authority) and echoes only non-sensitive shape, never the key. Nothing is read at import,
 * and no file is loaded here: packages/embeddings/.env is loaded by the Node entry (./node).
 */
export const getVoyageApiKey = requireEnv({
  name: "VOYAGE_API_KEY",
  notSetMessage:
    "VOYAGE_API_KEY is not set. Paste your Voyage AI API key into packages/embeddings/.env " +
    "(VOYAGE_API_KEY=pa-...), or export it as an environment variable.",
  prefix: "pa-",
});
