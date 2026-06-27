import { loadPackageEnv, requireEnv } from "@opusfinder/shared/env";

// Load packages/embeddings/.env relative to THIS module (see loadPackageEnv), so
// cross-package callers (the sources ingestion script and other pipelines) pick up
// VOYAGE_API_KEY from their own directories too.
loadPackageEnv(import.meta.url);

/**
 * Read + validate VOYAGE_API_KEY. The soft "pa-" prefix check warns but never hard-fails
 * (prefixes can change; the provider is the real authority) and echoes only non-sensitive
 * shape, never the key.
 */
export const getVoyageApiKey = requireEnv({
  name: "VOYAGE_API_KEY",
  notSetMessage:
    "VOYAGE_API_KEY is not set. Paste your Voyage AI API key into packages/embeddings/.env " +
    "(VOYAGE_API_KEY=pa-...), or export it as an environment variable.",
  prefix: "pa-",
});
