import { randomBytes } from "node:crypto";

import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgSerial, type PgTable } from "drizzle-orm/pg-core";

import { companies, dataFixes, jobs, sourceRuns } from "./schema";

type TablePrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

/**
 * A limited Postgres login. It can use the tables in `grants` and nothing else: no user / auth / session / CV /
 * profile / preference / digest / health table, no DDL, no role memberships. Its setup script creates it with
 * plain SQL because a role made in the Neon Console, CLI or API joins `neon_superuser`
 * (https://neon.com/docs/manage/roles), which would grant pg_write_all_data and CREATEROLE.
 */
export interface LimitedRole {
  /** A plain lowercase identifier: the setup SQL splices it in unquoted. */
  readonly name: string;
  /** Schema objects, not names, so a rename can't drift. A table the role may INSERT into also gets USAGE on
   *  its serial sequences. */
  readonly grants: readonly {
    readonly tables: readonly PgTable[];
    readonly privileges: readonly TablePrivilege[];
  }[];
}

/** The data-fixes GitHub Action's only credential (`data-fixer:setup`): the ingestion-side tables, plus
 *  recording each fix in `data_fixes`. */
export const DATA_FIXER: LimitedRole = {
  name: "data_fixer",
  grants: [
    {
      tables: [companies, jobs, sourceRuns],
      privileges: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    },
    { tables: [dataFixes], privileges: ["SELECT", "INSERT"] },
  ],
};

/** The ingest Worker's (apps/scrapers) DATABASE_URL (`worker-role:setup`): what runIngestion and runDiscovery
 *  touch. No DELETE: no Worker path deletes a row. */
export const SCRAPERS_WORKER: LimitedRole = {
  name: "scrapers_worker",
  grants: [{ tables: [companies, jobs, sourceRuns], privileges: ["SELECT", "INSERT", "UPDATE"] }],
};

/** A fresh 256-bit password, base64url (so it needs no escaping in a URL). Neon requires ≥ 60 bits. */
export function generateRolePassword(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The setting a role's setup SQL reads its password from. The setup script binds the password into it as a
 * query parameter instead of splicing it into the SQL, because statement text is kept in pg_stat_activity and,
 * when that extension is installed, pg_stat_statements: readable by the role that ran it, even from a read-only
 * session, and by pg_read_all_stats members.
 */
export function passwordSetting(role: LimitedRole): string {
  return `opusfinder.${role.name}_password`;
}

/** The privileges Postgres can grant on single columns (which has_table_privilege doesn't see). */
const COLUMN_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "REFERENCES"];
const TABLE_ONLY_PRIVILEGES = ["DELETE", "TRUNCATE", "TRIGGER"];

/** The sequences behind a table's serial columns, as Postgres names them. */
function serialSequences(table: PgTable): string[] {
  return Object.values(getTableColumns(table))
    .filter((column) => is(column, PgSerial))
    .map((column) => `${getTableName(table)}_${column.name}_seq`);
}

/**
 * A role's setup SQL, run by the owner's role in ONE transaction after binding the password into
 * {@link passwordSetting}. Idempotent: it creates the role or rotates its password, then resets its table
 * privileges to `grants` (revoke all, grant the list), so a re-run converges even if the list shrank. Aborts if
 * a granted table is missing (run the migration first), if the role has elevated attributes or any role
 * membership (e.g. it was created in the Neon Console), or if the role still holds any privilege on a public
 * table beyond `grants` afterwards. That last check matters because the owner's REVOKE only removes the
 * owner's own grants, so a grant made by another role would survive it.
 */
export function buildRoleSetupSql(role: LimitedRole): string {
  const name = role.name;
  const setting = passwordSetting(role);
  const groups = role.grants.map((g) => ({
    tables: g.tables.map((t) => getTableName(t)),
    privileges: g.privileges as readonly string[],
    sequences: g.privileges.includes("INSERT") ? g.tables.flatMap(serialSequences) : [],
  }));
  const literals = (names: readonly string[]) => names.map((n) => `'${n}'`).join(", ");
  const sequences = groups.flatMap((g) => g.sequences);
  // Per granted table, the privileges it must NOT hold; ELSE (every other table) is all of them.
  const notGranted = (all: readonly string[]) =>
    groups
      .map(
        (g) =>
          `WHEN t.tablename IN (${literals(g.tables)}) THEN '${all.filter((p) => !g.privileges.includes(p)).join(", ")}'`,
      )
      .join("\n             ");
  return `DO $$
DECLARE
  new_password text := current_setting('${setting}');
  missing text;
BEGIN
  IF length(new_password) < 32 THEN
    RAISE EXCEPTION 'bind a password of at least 32 characters into ${setting} first';
  END IF;
  SELECT string_agg(t, ', ') INTO missing
  FROM unnest(ARRAY[${literals(groups.flatMap((g) => g.tables))}]) AS t
  WHERE to_regclass(format('public.%I', t)) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing table(s) %: run pnpm db:migrate first', missing;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN
    EXECUTE format('ALTER ROLE ${name} WITH LOGIN PASSWORD %L', new_password);
  ELSE
    EXECUTE format('CREATE ROLE ${name} WITH LOGIN PASSWORD %L', new_password);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname = '${name}'
      AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication
           OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid))
  ) THEN
    RAISE EXCEPTION '${name} has elevated attributes or role memberships (created in the Neon Console?): drop it with SQL, then re-run';
  END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${name};
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${name};
GRANT USAGE ON SCHEMA public TO ${name};
${groups.map((g) => `GRANT ${g.privileges.join(", ")} ON ${g.tables.join(", ")} TO ${name};`).join("\n")}
${sequences.length > 0 ? `GRANT USAGE ON SEQUENCE ${sequences.join(", ")} TO ${name};` : ""}
DO $$
DECLARE
  extra text;
BEGIN
  -- Effective privileges (direct, via PUBLIC, from any grantor) beyond the allowlist above.
  SELECT string_agg(t.tablename, ', ' ORDER BY t.tablename) INTO extra
  FROM pg_tables t
  WHERE t.schemaname = 'public'
    AND (has_any_column_privilege('${name}', format('%I.%I', t.schemaname, t.tablename),
           CASE
             ${notGranted(COLUMN_PRIVILEGES)}
             ELSE '${COLUMN_PRIVILEGES.join(", ")}'
           END)
         OR has_table_privilege('${name}', format('%I.%I', t.schemaname, t.tablename),
           CASE
             ${notGranted(TABLE_ONLY_PRIVILEGES)}
             ELSE '${TABLE_ONLY_PRIVILEGES.join(", ")}'
           END));
  IF extra IS NOT NULL OR has_schema_privilege('${name}', 'public', 'CREATE') THEN
    RAISE EXCEPTION '${name} holds privileges beyond its allowlist (on: %; or CREATE on schema public), granted by another role: revoke them, then re-run', coalesce(extra, 'no table');
  END IF;
END $$;
`;
}

/** The owner's connection string with the user + password swapped for the role's (host, db, params kept). */
export function buildRoleUrl(ownerUrl: string, role: LimitedRole, password: string): string {
  const url = new URL(ownerUrl);
  url.username = role.name;
  url.password = password;
  return url.toString();
}

/** Replace every occurrence of `secret` in `text`, for anything printed. */
export function redact(text: string, secret: string): string {
  return text.replaceAll(secret, "<redacted>");
}
