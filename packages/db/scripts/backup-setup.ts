import { runScript } from "@opusfinder/shared/script";

import { directUrl, libpqEnv } from "../src/backup";
import { getDatabaseUrl } from "../src/env";
import { buildRoleSetupSql, buildRoleUrl, generateRolePassword, USER_BACKUP } from "../src/roles";
import { BACKUP_R2_ENV, getBackupR2Env } from "./lib/backup";
import { currentRepo, ensureEnvironment, setEnvironmentSecret } from "./lib/github-env";
import { isDryRun, setUpRole } from "./lib/role-setup";

// OWNER, one time (again to rotate the password, and after a migration adds a table to BACKUP_TABLES), from a
// normal terminal with `gh` logged in, once the bucket and its token exist (packages/db/README.md "Backups"):
//   set -a; . ~/.config/opusfinder/db.env; . ~/.config/opusfinder/backup-r2.env; set +a
//   pnpm --filter @opusfinder/db run backup:setup            (add -- --dry-run to only print the SQL)
// 1. Creates/updates the `backup` GitHub Environment so only `main` can deploy to it, and sets its four
//    BACKUP_R2_* secrets.
// 2. With DATABASE_URL (the owner's role): creates the user_backup role or rotates its password, and resets
//    its grants (src/roles.ts), in one transaction.
// 3. Sets the Environment's BACKUP_DATABASE_URL secret to user_backup's direct connection string.
// Every value goes to `gh secret set` on stdin; nothing secret is printed. Safe to re-run: if a step fails,
// run it again.

const ENVIRONMENT = "backup";
const SECRET = "BACKUP_DATABASE_URL";

await runScript("backup setup", async () => {
  const dryRun = isDryRun();
  const password = generateRolePassword();

  if (dryRun) {
    console.log(
      "Dry run: nothing is changed. The role SQL (one transaction; the password is bound separately):\n",
    );
    console.log(buildRoleSetupSql(USER_BACKUP));
    console.log(
      `Then: GitHub Environment "${ENVIRONMENT}" with deployments from main only, its ${BACKUP_R2_ENV.join(", ")} ` +
        `secrets set from the environment, and its ${SECRET} secret set to DATABASE_URL's direct host with the ` +
        `user and password replaced by ${USER_BACKUP.name}'s.`,
    );
    return;
  }

  // All checked first, so a missing value fails before anything changes.
  const r2 = getBackupR2Env();
  const ownerUrl = getDatabaseUrl();
  const backupUrl = directUrl(buildRoleUrl(ownerUrl, USER_BACKUP, password));
  // The nightly run hands this URL to the libpq tools, which take only the parameters libpqEnv knows.
  libpqEnv(backupUrl);

  const repo = currentRepo();
  ensureEnvironment(repo, ENVIRONMENT);
  for (const name of BACKUP_R2_ENV) setEnvironmentSecret(repo, ENVIRONMENT, name, r2[name]);
  console.log(
    `GitHub Environment ${ENVIRONMENT} on ${repo}: deployments from main only; ${BACKUP_R2_ENV.join(", ")} set.`,
  );

  const existed = await setUpRole(ownerUrl, USER_BACKUP, password);
  console.log(
    `Role ${USER_BACKUP.name}: ${existed ? "password rotated" : "created"}; grants reset.`,
  );

  try {
    setEnvironmentSecret(repo, ENVIRONMENT, SECRET, backupUrl);
  } catch (err) {
    // The role's password is already changed, so the stored secret is now stale until this succeeds.
    throw new Error(`password changed but secret ${SECRET} not updated: re-run setup`, {
      cause: err,
    });
  }
  console.log(`Secret ${SECRET} set on environment ${ENVIRONMENT}.`);
});
