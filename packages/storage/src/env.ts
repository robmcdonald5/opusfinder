import { loadPackageEnv, requireEnv } from "@opusfinder/shared/env";

import type { R2Config } from "./types";

// Node-only env reader for the R2 client. Imported ONLY by scripts (it runs loadPackageEnv at module
// load), never by a Worker-bound module — same discipline as the other packages' ./env subpaths.
loadPackageEnv(import.meta.url);

const getR2AccessKeyId = requireEnv({
  name: "R2_ACCESS_KEY_ID",
  notSet:
    "R2_ACCESS_KEY_ID is not set. Create an R2 API token (Object Read & Write) and paste its Access Key ID into packages/storage/.env.",
});
const getR2SecretAccessKey = requireEnv({
  name: "R2_SECRET_ACCESS_KEY",
  notSet:
    "R2_SECRET_ACCESS_KEY is not set. Paste the R2 token's Secret Access Key into packages/storage/.env.",
});
const getR2BucketName = requireEnv({
  name: "R2_BUCKET_NAME",
  notSet: "R2_BUCKET_NAME is not set. Paste your R2 bucket name into packages/storage/.env.",
});
const getR2AccountId = requireEnv({
  name: "R2_ACCOUNT_ID",
  notSet:
    "Neither S3_ENDPOINT_URL nor R2_ACCOUNT_ID is set. Set one in packages/storage/.env (the S3 endpoint URL, or the account id to derive it).",
});

/**
 * Read the R2 connection config from the environment (scripts only — pulls loadPackageEnv). Prefers
 * an explicit `S3_ENDPOINT_URL` (handles jurisdiction-specific endpoints); otherwise derives the
 * default endpoint from `R2_ACCOUNT_ID`.
 */
export function getR2Config(): R2Config {
  const explicit = process.env.S3_ENDPOINT_URL?.trim();
  const endpoint =
    explicit && explicit.length > 0 ? explicit : `https://${getR2AccountId()}.r2.cloudflarestorage.com`;
  return {
    endpoint,
    accessKeyId: getR2AccessKeyId(),
    secretAccessKey: getR2SecretAccessKey(),
    bucket: getR2BucketName(),
  };
}
