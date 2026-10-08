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

/** A fresh 256-bit password, base64url (so it needs no quoting in SQL or a URL). Neon requires ≥ 60 bits. */
export function generateDataFixerPassword(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The setup SQL, run by the owner's role in ONE transaction. Idempotent: it creates the role or rotates its
 * password, then RESETS its table privileges to exactly the allowlist (revoke all, grant the list), so a re-run
 * converges even if the list shrank. Aborts if `data_fixes` is missing (run the migration first) or if the role
 * has elevated attributes or any role membership (e.g. it was created in the Neon Console).
 */
export function buildDataFixerSetupSql(password: string): string {
  // The password is spliced into the SQL (CREATE/ALTER ROLE take no bind parameters), so pin its alphabet.
  if (!/^[A-Za-z0-9_-]{32,}$/.test(password)) {
    throw new Error("data_fixer password must be at least 32 base64url characters");
  }
  const role = DATA_FIXER_ROLE;
  const tables = DATA_FIXER_TABLES.join(", ");
  const sequences = DATA_FIXER_TABLES.map((t) => `${t}_id_seq`).join(", ");
  return `DO $$
BEGIN
  IF to_regclass('public.${getTableName(dataFixes)}') IS NULL THEN
    RAISE EXCEPTION 'the ${getTableName(dataFixes)} table is missing: run pnpm db:migrate first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}';
  ELSE
    CREATE ROLE ${role} WITH LOGIN PASSWORD '${password}';
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
