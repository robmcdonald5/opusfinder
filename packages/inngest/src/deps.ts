// The /node entries load packages/llm/.env and packages/email/.env; the keys themselves are read when a
// call is made.
import "@opusfinder/email/node";
import "@opusfinder/llm/node";

import { getDatabaseUrl } from "@opusfinder/db/env";
import { buildDigestDeps as buildDeps, type DigestDeps } from "@opusfinder/digest";
import { parseEnforceFlag } from "@opusfinder/shared";

/**
 * The digest deps for the Node-hosted Inngest functions: @opusfinder/digest's production deps, with the
 * database URL, the API keys and LIFECYCLE_CLOSE_ENFORCE taken from the environment. NODE/server-only; the
 * serve route and the CLI scripts call it.
 */
export function buildDigestDeps(): DigestDeps {
  return buildDeps({
    databaseUrl: getDatabaseUrl(),
    enforceLifecycle: parseEnforceFlag(process.env.LIFECYCLE_CLOSE_ENFORCE),
  });
}
