import { requireEnv } from "@opusfinder/shared/require-env";

/**
 * Read + validate OPENROUTER_API_KEY from the ambient environment: the fallback for a call that passes
 * no `apiKey`. The soft "sk-or-" prefix check warns but never hard-fails (prefixes can change; the
 * provider is the real authority) and echoes only non-sensitive shape, never the key. Nothing is read at
 * import, and no file is loaded here: packages/llm/.env is loaded by the Node entry (./node).
 */
export const getOpenRouterApiKey = requireEnv({
  name: "OPENROUTER_API_KEY",
  notSetMessage:
    "OPENROUTER_API_KEY is not set. Paste your OpenRouter API key into packages/llm/.env " +
    "(OPENROUTER_API_KEY=sk-or-...), or export it as an environment variable.",
  prefix: "sk-or-",
});
