import { fileURLToPath } from "node:url";

import { config } from "dotenv";

// Resolve packages/embeddings/.env relative to THIS module, not the cwd. The backfill
// + search scripts run with cwd=packages/embeddings, but cross-package callers (the
// sources ingestion script, Phase 9 CV ingest, Phase 10 digest pipeline) import this
// guard from their own directories — a cwd-relative load would silently miss the file
// and leave VOYAGE_API_KEY undefined. fileURLToPath (not a raw file:// string) keeps
// the Windows drive-letter path valid. quiet: silence dotenv@17's load banner. dotenv
// does NOT override an already-set process env var, so a real VOYAGE_API_KEY in the
// shell still wins.
config({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });

/**
 * Read + validate VOYAGE_API_KEY. The `config()` call above loads
 * packages/embeddings/.env resolved relative to THIS module (see the note there), so
 * any package's scripts — not just embeddings' — pick it up regardless of the cwd they
 * run from.
 *
 * Centralizes the env guard so every caller shares one friendly, actionable error
 * instead of an opaque provider 401. Throws (never returns a bad value). The error and
 * the soft-prefix warning echo only non-sensitive shape (presence, length, and whether
 * the expected "pa-" prefix is there) — never the key itself, so the secret never lands
 * in logs/CI output.
 */
export function getVoyageApiKey(): string {
  const key = process.env.VOYAGE_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "VOYAGE_API_KEY is not set. Paste your Voyage AI API key into packages/embeddings/.env " +
        "(VOYAGE_API_KEY=pa-...), or export it as an environment variable.",
    );
  }
  // Soft sanity check only. Voyage keys start with "pa-", but don't hard-fail on it —
  // prefixes can change and the provider is the real authority. Echo only the
  // non-sensitive shape, never the key.
  if (!key.startsWith("pa-")) {
    console.warn(
      `VOYAGE_API_KEY is set (length ${key.length}) but does not start with "pa-"; ` +
        "proceeding anyway.",
    );
  }
  return key;
}
