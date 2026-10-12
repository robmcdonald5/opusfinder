import type { PGlite } from "@electric-sql/pglite";

import { buildRoleSetupSql, passwordSetting, type LimitedRole } from "@opusfinder/db/roles";

/**
 * What a limited role's setup script (packages/db/scripts/lib/role-setup.ts) sends, run as the PGlite owner:
 * the password bound into the role's setting, then the setup SQL.
 */
export async function setUpRole(
  pg: PGlite,
  role: LimitedRole,
  password = "p".repeat(32),
): Promise<void> {
  await pg.query("SELECT set_config($1, $2, false)", [passwordSetting(role), password]);
  await pg.exec(buildRoleSetupSql(role));
}
