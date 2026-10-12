import { Client } from "@neondatabase/serverless";

import { buildRoleSetupSql, passwordSetting, redact, type LimitedRole } from "../../src/roles";

/**
 * Create `role` or rotate its password, and reset its grants (src/roles.ts), in one transaction as the owner.
 * The password is bound as a query parameter, never spliced into the SQL. Returns whether the role existed.
 */
export async function setUpRole(
  ownerUrl: string,
  role: LimitedRole,
  password: string,
): Promise<boolean> {
  const client = new Client(ownerUrl);
  // Same as apply-fixes.ts: a dropped connection must reject the query, not crash the process.
  let lost = false;
  client.on("error", () => {
    lost = true;
  });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role.name]);
    await client.query("BEGIN");
    await client.query("SELECT set_config($1, $2, true)", [passwordSetting(role), password]);
    await client.query(buildRoleSetupSql(role));
    await client.query("COMMIT");
    return rows.length > 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line preserve-caught-error -- no `cause` on purpose: its unredacted message could echo the password
    throw new Error(`role setup rolled back: ${redact(message, password)}`);
  } finally {
    const ended = client.end();
    if (!lost) await ended;
  }
}
