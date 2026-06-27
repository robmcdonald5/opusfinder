import { loadPackageEnv, requireEnv } from "@opusfinder/shared/env";

// Load packages/llm/.env relative to THIS module (see loadPackageEnv), so cross-package
// callers pick up the key from their own directories too.
loadPackageEnv(import.meta.url);

/**
 * Read + validate ANTHROPIC_API_KEY. The soft "sk-ant-" prefix check warns but never
 * hard-fails (prefixes can change; the provider is the real authority) and echoes only
 * non-sensitive shape, never the key.
 */
export const getAnthropicApiKey = requireEnv({
  name: "ANTHROPIC_API_KEY",
  notSetMessage:
    "ANTHROPIC_API_KEY is not set. Paste your Anthropic API key into packages/llm/.env " +
    "(ANTHROPIC_API_KEY=sk-ant-...), or export it as an environment variable.",
  prefix: "sk-ant-",
});
