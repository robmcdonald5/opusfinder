import { runScript } from "@opusfinder/shared/script";

import { DIGEST_WORKER } from "../src/roles";
import { setUpWorkerRole } from "./lib/worker-role-setup";

// OWNER, once before the digest Worker's first deploy, then again after any migration that adds a table the
// digest or the health check uses (or to rotate the password), from a normal terminal with wrangler logged in:
//   pnpm --filter @opusfinder/db run digest-role:setup            (add -- --dry-run to only print the SQL)
// Creates the digest_worker role or rotates its password, resets its grants (src/roles.ts), checks the new
// login can insert into digests, and puts its connection string in the digest Worker's DATABASE_URL secret
// (lib/worker-role-setup.ts has the steps). Never prints the password or a connection string.
// The Worker must exist for the secret to land: on the very first setup, deploy it once before this (both
// its stages are off, so that deploy runs nothing).

await runScript("digest-role setup", () =>
  setUpWorkerRole({
    role: DIGEST_WORKER,
    app: "digest",
    mustHold: { table: "digests", privilege: "INSERT" },
  }),
);
