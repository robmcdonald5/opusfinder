import { loadPackageEnv, requireEnv } from "@opusfinder/shared/env";

// Load packages/llm/.env relative to THIS module (see loadPackageEnv), so cross-package
// callers pick up the key from their own directories too.
loadPackageEnv(import.meta.url);

/**
 * Read + validate OPENROUTER_API_KEY. The soft "sk-or-" prefix check warns but never
 * hard-fails (prefixes can change; the provider is the real authority) and echoes only
 * non-sensitive shape, never the key.
 */
export const getOpenRouterApiKey = requireEnv({
  name: "OPENROUTER_API_KEY",
  notSetMessage:
    "OPENROUTER_API_KEY is not set. Paste your OpenRouter API key into packages/llm/.env " +
    "(OPENROUTER_API_KEY=sk-or-...), or export it as an environment variable.",
  prefix: "sk-or-",
});
