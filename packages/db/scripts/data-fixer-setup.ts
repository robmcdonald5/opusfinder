import { runScript } from "@opusfinder/shared/script";

import { getDatabaseUrl } from "../src/env";
import { buildRoleSetupSql, buildRoleUrl, DATA_FIXER, generateRolePassword } from "../src/roles";
import { currentRepo, ensureEnvironment, setEnvironmentSecret } from "./lib/github-env";
import { isDryRun, setUpRole } from "./lib/role-setup";

// OWNER, one time (and again to rotate the password), from a normal terminal with `gh` logged in:
//   pnpm --filter @opusfinder/db run data-fixer:setup            (add -- --dry-run to only print the SQL)
// 1. Creates/updates the `data-fixes` GitHub Environment so only `main` can deploy to it.
// 2. With DATABASE_URL (the owner's role, exported from outside the repo): creates the data_fixer role or
//    rotates its password, and resets its grants (src/roles.ts), in one transaction.
// 3. Pipes data_fixer's connection string into `gh secret set DATA_FIX_DATABASE_URL --env data-fixes` on stdin.
// Never prints the password or the connection string. Safe to re-run: if a step fails, run it again.

const ENVIRONMENT = "data-fixes";
const SECRET = "DATA_FIX_DATABASE_URL";

await runScript("data-fixer setup", async () => {
  const dryRun = isDryRun();
  const password = generateRolePassword();

  if (dryRun) {
    console.log(
      "Dry run: nothing is changed. The role SQL (one transaction; the password is bound separately):\n",
    );
    console.log(buildRoleSetupSql(DATA_FIXER));
    console.log(
      `Then: GitHub Environment "${ENVIRONMENT}" with deployments from main only, and its ${SECRET} secret ` +
        `set from stdin to DATABASE_URL with the user and password replaced by ${DATA_FIXER.name}'s.`,
    );
    return;
  }

  const repo = currentRepo();
  ensureEnvironment(repo, ENVIRONMENT);
  console.log(`GitHub Environment ${ENVIRONMENT} on ${repo}: deployments from main only.`);

  const ownerUrl = getDatabaseUrl();
  const existed = await setUpRole(ownerUrl, DATA_FIXER, password);
  console.log(
    `Role ${DATA_FIXER.name}: ${existed ? "password rotated" : "created"}; grants reset.`,
  );

  try {
    setEnvironmentSecret(repo, ENVIRONMENT, SECRET, buildRoleUrl(ownerUrl, DATA_FIXER, password));
  } catch (err) {
    // The role's password is already changed, so the stored secret is now stale until this succeeds.
    throw new Error(`password changed but secret ${SECRET} not updated: re-run setup`, {
      cause: err,
    });
  }
  console.log(`Secret ${SECRET} set on environment ${ENVIRONMENT}.`);
});
