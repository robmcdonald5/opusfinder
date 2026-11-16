// packages/eval/.env is loaded by ../env (loadPackageEnv resolves the file from a module one level
// below the package root, which this one is not).
import "../env";
// Loads packages/llm/.env, where the OpenRouter key lives.
import "@opusfinder/llm/node";

import { requireEnv } from "@opusfinder/shared/env";
import type { R2Config } from "@opusfinder/storage";

export { getOpenRouterApiKey } from "@opusfinder/llm/env";

/** The DeepInfra key, for the challenger OpenRouter doesn't serve under no-training terms. Never logged. */
export const getDeepInfraApiKey = requireEnv({
  name: "DEEPINFRA_API_KEY",
  notSetMessage:
    "DEEPINFRA_API_KEY is not set. Paste a DeepInfra API key into packages/eval/.env " +
    "(DEEPINFRA_API_KEY=...), or export it as an environment variable.",
});

/** The eval bucket's settings. Its token is scoped to that bucket alone, so these are separate from
 *  the CV bucket's R2_* names in packages/storage/.env. */
export const EVAL_R2_ENV = [
  "EVAL_R2_ACCOUNT_ID",
  "EVAL_R2_BUCKET",
  "EVAL_R2_ACCESS_KEY_ID",
  "EVAL_R2_SECRET_ACCESS_KEY",
] as const;

/** The S3 client config for the eval bucket, or a throw naming the first setting missing. */
export function getEvalR2Config(): R2Config {
  const read = (name: (typeof EVAL_R2_ENV)[number]) =>
    requireEnv({
      name,
      notSetMessage: `${name} is not set. Add the eval bucket's settings to packages/eval/.env; see packages/eval/README.md "Job snapshot".`,
    })();
  return {
    endpoint: `https://${read("EVAL_R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    bucket: read("EVAL_R2_BUCKET"),
    accessKeyId: read("EVAL_R2_ACCESS_KEY_ID"),
    secretAccessKey: read("EVAL_R2_SECRET_ACCESS_KEY"),
  };
}
