import { describe, expect, it } from "vitest";

import {
  buildDataFixerSetupSql,
  buildDataFixerUrl,
  DATA_FIXER_TABLES,
  generateDataFixerPassword,
  redact,
} from "./fixer-role";

// Pure-unit suite for the data_fixer setup builders (what `data-fixer:setup` sends and stores). Whether the
// grants actually confine the role on a real Postgres is fixes.integration.test.ts.

const PASSWORD = "A".repeat(20) + "b-c_d".repeat(4); // 40 base64url chars

describe("DATA_FIXER_TABLES", () => {
  it("is exactly the ingestion-side tables (widening it is a deliberate, reviewed change)", () => {
    expect(DATA_FIXER_TABLES).toEqual(["companies", "jobs", "source_runs"]);
  });
});

describe("buildDataFixerSetupSql", () => {
  it("creates or rotates the role, then resets its grants to the allowlist", () => {
    const sql = buildDataFixerSetupSql();
    expect(sql).toContain("ALTER ROLE data_fixer WITH LOGIN PASSWORD %L");
    expect(sql).toContain("CREATE ROLE data_fixer WITH LOGIN PASSWORD %L");
    expect(sql).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM data_fixer;");
    expect(sql).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON companies, jobs, source_runs TO data_fixer;",
    );
    expect(sql).toContain(
      "GRANT USAGE ON SEQUENCE companies_id_seq, jobs_id_seq, source_runs_id_seq TO data_fixer;",
    );
    expect(sql).toContain("GRANT SELECT, INSERT ON data_fixes TO data_fixer;");
  });
});

describe("generateDataFixerPassword", () => {
  it("returns a fresh 256-bit base64url password", () => {
    const a = generateDataFixerPassword();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(generateDataFixerPassword());
  });
});

describe("buildDataFixerUrl", () => {
  it("swaps in data_fixer's user and password and keeps host, database and params", () => {
    const url = buildDataFixerUrl(
      "postgresql://neondb_owner:owner-secret@ep-x-123.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
      PASSWORD,
    );
    expect(url).toBe(
      `postgresql://data_fixer:${PASSWORD}@ep-x-123.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`,
    );
    expect(url).not.toContain("owner-secret");
  });
});

describe("redact", () => {
  it("replaces every occurrence of the secret", () => {
    expect(redact(`a ${PASSWORD} b ${PASSWORD}`, PASSWORD)).toBe("a <redacted> b <redacted>");
  });
});
