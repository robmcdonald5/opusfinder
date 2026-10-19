import { describe, expect, it } from "vitest";

import {
  buildRoleSetupSql,
  buildRoleUrl,
  DATA_FIXER,
  generateRolePassword,
  redact,
  SCRAPERS_WORKER,
} from "./roles";
import { PRUNE_FUNCTION } from "./repos/prune";

// Pure-unit suite for the limited-role setup builders (what `data-fixer:setup` and `worker-role:setup` send and
// store). Whether the grants actually confine each role on a real Postgres is roles.integration.test.ts.

const PASSWORD = "A".repeat(20) + "b-c_d".repeat(4); // 40 base64url chars

// Pinned: widening either role is a deliberate, reviewed change.
describe("buildRoleSetupSql", () => {
  it("data_fixer: creates or rotates the role, then resets its grants to the allowlist", () => {
    const sql = buildRoleSetupSql(DATA_FIXER);
    expect(sql).toContain("ALTER ROLE data_fixer WITH LOGIN PASSWORD %L");
    expect(sql).toContain("CREATE ROLE data_fixer WITH LOGIN PASSWORD %L");
    expect(sql).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM data_fixer;");
    expect(sql.match(/^GRANT .*$/gm)).toEqual([
      "GRANT USAGE ON SCHEMA public TO data_fixer;",
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.companies, public.jobs, public.source_runs TO data_fixer;",
      "GRANT SELECT, INSERT ON public.data_fixes TO data_fixer;",
      "GRANT USAGE ON SEQUENCE public.companies_id_seq, public.jobs_id_seq, public.source_runs_id_seq TO data_fixer;",
    ]);
  });

  it("scrapers_worker: read/insert/update on the ingestion tables, no DELETE, EXECUTE on the prune only", () => {
    const sql = buildRoleSetupSql(SCRAPERS_WORKER);
    expect(sql).toContain("CREATE ROLE scrapers_worker WITH LOGIN PASSWORD %L");
    expect(sql).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM scrapers_worker;");
    expect(sql).toContain("REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM scrapers_worker;");
    expect(sql.match(/^GRANT .*$/gm)).toEqual([
      "GRANT USAGE ON SCHEMA public TO scrapers_worker;",
      "GRANT SELECT, INSERT, UPDATE ON public.companies, public.jobs, public.source_runs TO scrapers_worker;",
      "GRANT USAGE ON SEQUENCE public.companies_id_seq, public.jobs_id_seq, public.source_runs_id_seq TO scrapers_worker;",
      `GRANT EXECUTE ON FUNCTION ${PRUNE_FUNCTION} TO scrapers_worker;`,
    ]);
  });
});

describe("generateRolePassword", () => {
  it("returns a fresh 256-bit base64url password", () => {
    const a = generateRolePassword();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(generateRolePassword());
  });
});

describe("buildRoleUrl", () => {
  it("swaps in the role's user and password, drops user/password params, keeps host, database and params", () => {
    const url = buildRoleUrl(
      "postgresql://neondb_owner:owner-secret@ep-x-123.us-east-1.aws.neon.tech/neondb?sslmode=require&user=neondb_owner&password=owner-secret&channel_binding=require",
      SCRAPERS_WORKER,
      PASSWORD,
    );
    expect(url).toBe(
      `postgresql://scrapers_worker:${PASSWORD}@ep-x-123.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`,
    );
    expect(url).not.toContain("owner-secret");
  });
});

describe("redact", () => {
  it("replaces every occurrence of the secret", () => {
    expect(redact(`a ${PASSWORD} b ${PASSWORD}`, PASSWORD)).toBe("a <redacted> b <redacted>");
  });
});
