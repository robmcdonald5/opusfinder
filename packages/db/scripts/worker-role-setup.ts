import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { neon } from "@neondatabase/serverless";

import { runScript } from "@opusfinder/shared/script";

import { getDatabaseUrl } from "../src/env";
import {
  buildRoleSetupSql,
  buildRoleUrl,
  generateRolePassword,
  redact,
  SCRAPERS_WORKER,
} from "../src/roles";
import { isDryRun, setUpRole } from "./lib/role-setup";

// OWNER, once, then again after any migration that adds a table or sequence the Worker uses (or to rotate the
// password), from a normal terminal with wrangler logged in:
//   pnpm --filter @opusfinder/db run worker-role:setup            (add -- --dry-run to only print the SQL)
// 1. Checks wrangler can reach the scrapers Worker, before anything changes.
// 2. With DATABASE_URL (the owner's role, exported from outside the repo): creates the scrapers_worker role or
//    rotates its password, and resets its grants (src/roles.ts), in one transaction.
// 3. Connects as scrapers_worker over the Worker's driver (neon-http) and checks it can insert into jobs.
// 4. Pipes scrapers_worker's connection string into the Worker's DATABASE_URL secret (`wrangler secret put`,
//    stdin), which Cloudflare applies at once.
// Never prints the password or either connection string. Safe to re-run: if a step fails, run it again.

const SECRET = "DATABASE_URL"; // what apps/scrapers/src/index.ts reads
const SCRAPERS_DIR = fileURLToPath(new URL("../../../apps/scrapers/", import.meta.url));

/** The owner's database URL(s) stay out of wrangler's env, and its debug logs can't print the secret it sends. */
const WRANGLER_ENV = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/DATABASE_URL|^PG|^POSTGRES/.test(key)),
  ),
  WRANGLER_LOG_SANITIZE: "true",
};

/** wrangler from apps/scrapers, so it targets the Worker its wrangler.toml names. */
function wrangler(args: string[], input?: string): void {
  execFileSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: SCRAPERS_DIR,
    env: WRANGLER_ENV,
    input,
    stdio: ["pipe", "ignore", "inherit"],
  });
}

/** Fails unless `roleUrl` logs in as scrapers_worker and can insert into jobs, as the Worker will. */
async function checkRoleLogin(roleUrl: string, password: string): Promise<void> {
  try {
    const sql = neon(roleUrl);
    const rows = (await sql`SELECT current_user AS name,
      has_table_privilege('public.jobs', 'INSERT') AS can_insert`) as {
      name: string;
      can_insert: boolean;
    }[];
    const row = rows[0];
    if (row?.name !== SCRAPERS_WORKER.name || !row.can_insert) {
      throw new Error(
        `logged in as ${String(row?.name)}, INSERT on jobs ${String(row?.can_insert)}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line preserve-caught-error -- no `cause` on purpose: its unredacted message could echo the password
    throw new Error(
      `the new ${SCRAPERS_WORKER.name} login failed its check (${redact(redact(message, roleUrl), password)}); ` +
        `the Worker's ${SECRET} was NOT changed, so if it already connects as ${SCRAPERS_WORKER.name}, its ` +
        "ticks fail until a re-run succeeds",
    );
  }
}

await runScript("worker-role setup", async () => {
  const dryRun = isDryRun();
  const password = generateRolePassword();

  if (dryRun) {
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

  const roleUrl = buildRoleUrl(ownerUrl, SCRAPERS_WORKER, password);
  await checkRoleLogin(roleUrl, password);

  try {
    wrangler(["secret", "put", SECRET], roleUrl);
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
