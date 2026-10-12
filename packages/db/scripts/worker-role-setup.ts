import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runScript } from "@opusfinder/shared/script";

import { getDatabaseUrl } from "../src/env";
import {
  buildRoleSetupSql,
  buildRoleUrl,
  generateRolePassword,
  SCRAPERS_WORKER,
} from "../src/roles";
import { setUpRole } from "./lib/role-setup";

// OWNER, once, then again after any migration that adds a table or sequence the Worker uses (or to rotate the
// password), from a normal terminal with wrangler logged in:
//   pnpm --filter @opusfinder/db run worker-role:setup            (add -- --dry-run to only print the SQL)
// 1. Checks wrangler can reach the scrapers Worker, before anything changes.
// 2. With DATABASE_URL (the owner's role, exported from outside the repo): creates the scrapers_worker role or
//    rotates its password, and resets its grants (src/roles.ts), in one transaction.
// 3. Pipes scrapers_worker's connection string into the Worker's DATABASE_URL secret (`wrangler secret put`,
//    stdin), which Cloudflare applies at once.
// Never prints the password or either connection string. Safe to re-run: if a step fails, run it again.

const SECRET = "DATABASE_URL"; // what apps/scrapers/src/index.ts reads
const SCRAPERS_DIR = fileURLToPath(new URL("../../../apps/scrapers/", import.meta.url));

/** wrangler from apps/scrapers, so it targets the Worker its wrangler.toml names. */
function wrangler(args: string[], input?: string): void {
  execFileSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: SCRAPERS_DIR,
    input,
    stdio: ["pipe", "ignore", "inherit"],
  });
}

await runScript("worker-role setup", async () => {
  const password = generateRolePassword();

  if (process.argv.includes("--dry-run")) {
    console.log(
      "Dry run: nothing is changed. The role SQL (one transaction; the password is bound separately):\n",
    );
    console.log(buildRoleSetupSql(SCRAPERS_WORKER));
    console.log(
      `Then: the scrapers Worker's ${SECRET} secret set from stdin (wrangler secret put) to DATABASE_URL with ` +
        `the user and password replaced by ${SCRAPERS_WORKER.name}'s.`,
    );
    return;
  }

  const ownerUrl = getDatabaseUrl();
  // Fails here (not logged in, wrong account, no such Worker) before the password changes.
  wrangler(["secret", "list"]);

  const existed = await setUpRole(ownerUrl, SCRAPERS_WORKER, password);
  console.log(
    `Role ${SCRAPERS_WORKER.name}: ${existed ? "password rotated" : "created"}; grants reset.`,
  );

  try {
    wrangler(["secret", "put", SECRET], buildRoleUrl(ownerUrl, SCRAPERS_WORKER, password));
  } catch (err) {
    // The role's password is already changed, so the Worker's ticks fail until this succeeds.
    throw new Error(`password changed but the Worker's ${SECRET} was not updated: re-run setup`, {
      cause: err,
    });
  }
  console.log(
    `Secret ${SECRET} set on the scrapers Worker: it now connects as ${SCRAPERS_WORKER.name}.`,
  );
});
