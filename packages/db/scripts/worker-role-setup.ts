import { runScript } from "@opusfinder/shared/script";

import { SCRAPERS_WORKER } from "../src/roles";
import { setUpWorkerRole } from "./lib/worker-role-setup";

// OWNER, once, then again after any change that adds a table or sequence the Worker uses (or to rotate the
// password), from a normal terminal with wrangler logged in:
//   pnpm --filter @opusfinder/db run worker-role:setup            (add -- --dry-run to only print the SQL)
// Creates the scrapers_worker role or rotates its password, resets its grants (src/roles.ts), checks the new
// login can insert into jobs, and puts its connection string in the scrapers Worker's DATABASE_URL secret
// (lib/worker-role-setup.ts has the steps). Never prints the password or a connection string.

await runScript("worker-role setup", () =>
  setUpWorkerRole({
    role: SCRAPERS_WORKER,
    app: "scrapers",
    mustHold: { table: "jobs", privilege: "INSERT" },
  }),
);
