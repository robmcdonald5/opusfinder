import { loadPackageEnv, requireEnv } from "@opusfinder/shared/env";

// Load packages/eval/.env relative to THIS module (see loadPackageEnv), so the key is
// found however the eval scripts are invoked.
loadPackageEnv(import.meta.url);

/**
 * Read + validate OPENAI_API_KEY (used only by the eval OpenAI embedder, for the Voyage-vs-OpenAI
 * comparison). OpenAI is kept out of @opusfinder/embeddings (which stays Voyage-only); this guard
 * lives in eval because OpenAI is an evaluation alternative, not a shipped provider. Echoes only
 * non-sensitive shape, never the key.
 */
export const getOpenAiApiKey = requireEnv({
  name: "OPENAI_API_KEY",
  notSetMessage:
    "OPENAI_API_KEY is not set. Paste your OpenAI API key into packages/eval/.env " +
    "(OPENAI_API_KEY=sk-...), or export it as an environment variable.",
  prefix: "sk-",
});
