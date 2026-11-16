import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { neon } from "@neondatabase/serverless";

import { getDatabaseUrl } from "../../src/env";
import {
  buildRoleSetupSql,
  buildRoleUrl,
  generateRolePassword,
  redact,
  type LimitedRole,
} from "../../src/roles";
import { isDryRun, setUpRole } from "./role-setup";

/** A Cloudflare Worker that connects to Neon as its own limited role. */
export interface WorkerRole {
  role: LimitedRole;
  /** The Worker's app directory under apps/, whose wrangler.toml names the Worker. */
  app: string;
  /** A write the Worker makes on every run: the new login must hold it before the secret is changed. */
  mustHold: { table: string; privilege: "INSERT" | "UPDATE" };
}

const SECRET = "DATABASE_URL"; // what each Worker's code reads

/** The owner's database URL(s) stay out of wrangler's env, and its debug logs can't print the secret it sends. */
const WRANGLER_ENV = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/DATABASE_URL|^PG|^POSTGRES/.test(key)),
  ),
  WRANGLER_LOG_SANITIZE: "true",
};

/** wrangler from the Worker's app directory, so it targets the Worker its wrangler.toml names. */
function wrangler(app: string, args: string[], input?: string): void {
  execFileSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: fileURLToPath(new URL(`../../../../apps/${app}/`, import.meta.url)),
    env: WRANGLER_ENV,
    input,
    stdio: ["pipe", "ignore", "inherit"],
  });
}

/** Fails unless `roleUrl` logs in as the role and holds `mustHold`, over the Worker's driver (neon-http). */
async function checkRoleLogin(
  { role, app, mustHold }: WorkerRole,
  roleUrl: string,
  password: string,
): Promise<void> {
  try {
    const sql = neon(roleUrl);
    const rows = (await sql`SELECT current_user AS name,
      has_table_privilege(${`public.${mustHold.table}`}, ${mustHold.privilege}) AS holds`) as {
      name: string;
      holds: boolean;
    }[];
    const row = rows[0];
    if (row?.name !== role.name || !row.holds) {
      throw new Error(
        `logged in as ${String(row?.name)}, ${mustHold.privilege} on ${mustHold.table} ${String(row?.holds)}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line preserve-caught-error -- no `cause` on purpose: its unredacted message could echo the password
    throw new Error(
      `the new ${role.name} login failed its check (${redact(redact(message, roleUrl), password)}); ` +
        `the ${app} Worker's ${SECRET} was NOT changed, so if it already connects as ${role.name}, its ` +
        "runs fail until a re-run succeeds",
    );
  }
}

/**
 * Create a Worker's role or rotate its password, reset its grants, check the new login, and put its
 * connection string in the Worker's DATABASE_URL secret:
 * 1. Checks wrangler can reach the Worker, before anything changes.
 * 2. With DATABASE_URL (the owner's role, exported from outside the repo): creates the role or rotates its
 *    password, and resets its grants (src/roles.ts), in one transaction.
 * 3. Connects as the role over the Worker's driver (neon-http) and checks it holds `mustHold`.
 * 4. Pipes the role's connection string into the Worker's DATABASE_URL secret (`wrangler secret put`,
 *    stdin), which Cloudflare applies at once.
 * Never prints the password or either connection string. Safe to re-run: if a step fails, run it again.
 * `--dry-run` only prints the SQL.
 */
export async function setUpWorkerRole(worker: WorkerRole): Promise<void> {
  const { role, app } = worker;
  const password = generateRolePassword();

  if (isDryRun()) {
    console.log(
      "Dry run: nothing is changed. The role SQL (one transaction; the password is bound separately):\n",
    );
    console.log(buildRoleSetupSql(role));
    console.log(
      `Then: the ${app} Worker's ${SECRET} secret set from stdin (wrangler secret put) to DATABASE_URL with ` +
        `the user and password replaced by ${role.name}'s.`,
    );
    return;
  }

  const ownerUrl = getDatabaseUrl();
  // Fails here (not logged in, wrong account, no such Worker) before the password changes.
  wrangler(app, ["secret", "list"]);

  const existed = await setUpRole(ownerUrl, role, password);
  console.log(`Role ${role.name}: ${existed ? "password rotated" : "created"}; grants reset.`);

  const roleUrl = buildRoleUrl(ownerUrl, role, password);
  await checkRoleLogin(worker, roleUrl, password);

  try {
    wrangler(app, ["secret", "put", SECRET], roleUrl);
  } catch (err) {
    // The role's password is already changed, so the Worker's runs fail until this succeeds.
    throw new Error(`password changed but the Worker's ${SECRET} was not updated: re-run setup`, {
      cause: err,
    });
  }
  console.log(`Secret ${SECRET} set on the ${app} Worker: it now connects as ${role.name}.`);
}
