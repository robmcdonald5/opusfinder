import { randomBytes } from "node:crypto";

import { getTableName } from "drizzle-orm";

import { companies, dataFixes, jobs, sourceRuns } from "./schema";

/**
 * The `data_fixer` Postgres role: the only credential the data-fixes GitHub Action holds. It can read and
 * change the ingestion-side tables and record fixes in `data_fixes`, and nothing else: no user / auth / session /
 * CV / profile / preference / digest / health table, no DDL, no role memberships. Created with plain SQL by
 * `data-fixer:setup` (scripts/data-fixer-setup.ts) because a role made in the Neon Console, CLI or API joins
 * `neon_superuser` (https://neon.com/docs/manage/roles), which would grant pg_write_all_data and CREATEROLE.
 */
export const DATA_FIXER_ROLE = "data_fixer";

/** Tables a fix may SELECT / INSERT / UPDATE / DELETE. Derived from the schema objects so a rename can't drift. */
export const DATA_FIXER_TABLES: readonly string[] = [companies, jobs, sourceRuns].map((t) =>
  getTableName(t),
);

/** A fresh 256-bit password, base64url (so it needs no escaping in a URL). Neon requires ≥ 60 bits. */
export function generateDataFixerPassword(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The setting the setup SQL reads the password from. The script binds the password into it as a query
 * parameter instead of splicing it into the SQL, because statement text is kept in pg_stat_activity and, when
 * that extension is installed, pg_stat_statements: readable by the role that ran it, even from a read-only
 * session, and by pg_read_all_stats members.
 */
export const DATA_FIXER_PASSWORD_SETTING = "opusfinder.data_fixer_password";

/**
 * The setup SQL, run by the owner's role in ONE transaction after binding the password into
 * {@link DATA_FIXER_PASSWORD_SETTING}. Idempotent: it creates the role or rotates its password, then resets its
 * table privileges to the allowlist (revoke all, grant the list), so a re-run converges even if the list shrank.
 * Aborts if `data_fixes` is missing (run the migration first), if the role has elevated attributes or any role
 * membership (e.g. it was created in the Neon Console), or if the role still holds any privilege on a public
 * table beyond the allowlist afterwards. That last check matters because the owner's REVOKE only removes the
 * owner's own grants, so a grant made by another role would survive it.
 */
export function buildDataFixerSetupSql(): string {
  const role = DATA_FIXER_ROLE;
  const tables = DATA_FIXER_TABLES.join(", ");
  const tableLiterals = DATA_FIXER_TABLES.map((t) => `'${t}'`).join(", ");
  const sequences = DATA_FIXER_TABLES.map((t) => `${t}_id_seq`).join(", ");
  return `DO $$
DECLARE
  new_password text := current_setting('${DATA_FIXER_PASSWORD_SETTING}');
BEGIN
  IF length(new_password) < 32 THEN
    RAISE EXCEPTION 'bind a password of at least 32 characters into ${DATA_FIXER_PASSWORD_SETTING} first';
  END IF;
  IF to_regclass('public.${getTableName(dataFixes)}') IS NULL THEN
    RAISE EXCEPTION 'the ${getTableName(dataFixes)} table is missing: run pnpm db:migrate first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    EXECUTE format('ALTER ROLE ${role} WITH LOGIN PASSWORD %L', new_password);
  ELSE
    EXECUTE format('CREATE ROLE ${role} WITH LOGIN PASSWORD %L', new_password);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname = '${role}'
      AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication
           OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid))
  ) THEN
    RAISE EXCEPTION '${role} has elevated attributes or role memberships (created in the Neon Console?): drop it with SQL, then re-run';
  END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role};
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role};
GRANT USAGE ON SCHEMA public TO ${role};
GRANT SELECT, INSERT, UPDATE, DELETE ON ${tables} TO ${role};
GRANT USAGE ON SEQUENCE ${sequences} TO ${role};
GRANT SELECT, INSERT ON ${getTableName(dataFixes)} TO ${role};
DO $$
DECLARE
  extra text;
BEGIN
  -- Effective privileges (direct, via PUBLIC, from any grantor) beyond the allowlist above. SELECT, INSERT,
  -- UPDATE and REFERENCES can also be granted on single columns, which has_table_privilege doesn't see.
  SELECT string_agg(t.tablename, ', ' ORDER BY t.tablename) INTO extra
  FROM pg_tables t
  WHERE t.schemaname = 'public'
    AND (has_any_column_privilege('${role}', format('%I.%I', t.schemaname, t.tablename),
           CASE
             WHEN t.tablename IN (${tableLiterals}) THEN 'REFERENCES'
             WHEN t.tablename = '${getTableName(dataFixes)}' THEN 'UPDATE, REFERENCES'
             ELSE 'SELECT, INSERT, UPDATE, REFERENCES'
           END)
         OR has_table_privilege('${role}', format('%I.%I', t.schemaname, t.tablename),
           CASE
             WHEN t.tablename IN (${tableLiterals}) THEN 'TRUNCATE, TRIGGER'
             ELSE 'DELETE, TRUNCATE, TRIGGER'
           END));
  IF extra IS NOT NULL OR has_schema_privilege('${role}', 'public', 'CREATE') THEN
    RAISE EXCEPTION '${role} holds privileges beyond its allowlist (on: %; or CREATE on schema public), granted by another role: revoke them, then re-run', coalesce(extra, 'no table');
  END IF;
END $$;
`;
}

/** The owner's connection string with the user + password swapped for `data_fixer`'s (host, db, params kept). */
export function buildDataFixerUrl(ownerUrl: string, password: string): string {
  const url = new URL(ownerUrl);
  url.username = DATA_FIXER_ROLE;
  url.password = password;
  return url.toString();
}

/** Replace every occurrence of `secret` in `text`, for anything printed. */
export function redact(text: string, secret: string): string {
  return text.replaceAll(secret, "<redacted>");
}
