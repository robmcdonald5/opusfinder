import { fileURLToPath } from "node:url";

import { config } from "dotenv";

// Load packages/eval/.env resolved relative to THIS module (not the cwd), mirroring
// packages/embeddings/src/env.ts — so the key is found however the eval scripts are invoked.
// dotenv does NOT override an already-set process env var, so a real OPENAI_API_KEY in the shell
// still wins. quiet: silence dotenv@17's load banner.
config({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });

/**
 * Read + validate OPENAI_API_KEY (used only by the eval OpenAI embedder, for the Phase-5
 * Voyage-vs-OpenAI comparison). Throws with an actionable message that echoes only the
 * non-sensitive shape (presence, length, expected prefix) — never the key itself, per the repo's
 * no-secrets-in-logs rule. OpenAI is kept out of @opusfinder/embeddings (which stays Voyage-only);
 * this guard lives in eval because OpenAI is an evaluation alternative, not a shipped provider.
 */
export function getOpenAiApiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY is not set. Paste your OpenAI API key into packages/eval/.env " +
        "(OPENAI_API_KEY=sk-...), or export it as an environment variable.",
    );
  }
  if (!key.startsWith("sk-")) {
    console.warn(
      `OPENAI_API_KEY is set (length ${key.length}) but does not start with "sk-"; proceeding anyway.`,
    );
  }
  return key;
}
