import { execFileSync } from "node:child_process";

import { Client } from "@neondatabase/serverless";
import { runScript } from "@opusfinder/shared/script";

import { getDatabaseUrl } from "../src/env";
import {
  buildDataFixerSetupSql,
  buildDataFixerUrl,
  DATA_FIXER_ROLE,
  generateDataFixerPassword,
  redact,
} from "../src/fixer-role";

// OWNER, one time (and again to rotate the password), from a normal terminal with `gh` logged in:
//   pnpm --filter @opusfinder/db run data-fixer:setup            (add -- --dry-run to only print the SQL)
// 1. Creates/updates the `data-fixes` GitHub Environment so only `main` can deploy to it.
// 2. With DATABASE_URL (packages/db/.env, the owner's role): creates the data_fixer role or rotates its
//    password, and resets its grants (src/fixer-role.ts), in one transaction.
// 3. Pipes data_fixer's connection string into `gh secret set DATA_FIX_DATABASE_URL --env data-fixes` on stdin.
// Never prints the password or the connection string. Safe to re-run: if a step fails, run it again.

const ENVIRONMENT = "data-fixes";
const SECRET = "DATA_FIX_DATABASE_URL";

function gh(args: string[], input?: string): string {
  return execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] });
}

/** Create the environment if missing and allow deployments from `main` only. */
function ensureEnvironment(repo: string): void {
  const base = `repos/${repo}/environments/${ENVIRONMENT}`;
  const policy = {
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  gh(["api", "-X", "PUT", base, "--input", "-"], JSON.stringify(policy));
  const rules = gh([
    "api",
    `${base}/deployment-branch-policies`,
    "--jq",
    '.branch_policies[] | "\\(.type):\\(.name)"',
  ])
    .split("\n")
    .filter(Boolean);
  const others = rules.filter((r) => r !== "branch:main");
  if (others.length > 0) {
    throw new Error(
      `environment ${ENVIRONMENT} also allows ${others.join(", ")}; remove them under Settings → Environments, then re-run`,
    );
  }
  if (rules.length === 0) {
    gh([
      "api",
      "-X",
      "POST",
      `${base}/deployment-branch-policies`,
      "-f",
      "name=main",
      "-f",
      "type=branch",
    ]);
  }
}

/** Run the setup SQL in one transaction as the owner. Returns whether the role already existed. */
async function setUpRole(ownerUrl: string, password: string): Promise<boolean> {
  const client = new Client(ownerUrl);
  await client.connect();
  try {
    const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
      DATA_FIXER_ROLE,
    ]);
    await client.query("BEGIN");
    await client.query(buildDataFixerSetupSql(password));
    await client.query("COMMIT");
    return rows.length > 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line preserve-caught-error -- no `cause` on purpose: its unredacted message could echo the password
    throw new Error(`role setup rolled back: ${redact(message, password)}`);
  } finally {
    await client.end();
  }
}

await runScript("data-fixer setup", async () => {
  const password = generateDataFixerPassword();

  if (process.argv.includes("--dry-run")) {
    console.log(
      "Dry run: nothing is changed. The role SQL (one transaction, password redacted):\n",
    );
    console.log(redact(buildDataFixerSetupSql(password), password));
    console.log(
      `Then: GitHub Environment "${ENVIRONMENT}" with deployments from main only, and its ${SECRET} secret ` +
        `set from stdin to DATABASE_URL with the user and password replaced by ${DATA_FIXER_ROLE}'s.`,
    );
    return;
  }

  const repo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  ensureEnvironment(repo);
  console.log(`GitHub Environment ${ENVIRONMENT} on ${repo}: deployments from main only.`);

  const ownerUrl = getDatabaseUrl();
  const existed = await setUpRole(ownerUrl, password);
  console.log(
    `Role ${DATA_FIXER_ROLE}: ${existed ? "password rotated" : "created"}; grants reset.`,
  );

  try {
    gh(
      ["secret", "set", SECRET, "--env", ENVIRONMENT, "--repo", repo],
      buildDataFixerUrl(ownerUrl, password),
    );
  } catch (err) {
    // The role's password is already changed, so the stored secret is now stale until this succeeds.
    throw new Error(`password changed but secret ${SECRET} not updated: re-run setup`, {
      cause: err,
    });
  }
  console.log(`Secret ${SECRET} set on environment ${ENVIRONMENT}.`);
});
