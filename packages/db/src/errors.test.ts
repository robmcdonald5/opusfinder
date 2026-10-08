import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { describeDbError } from "./errors";

// Locks what a failed ingest records: a failed query's Postgres reason FIRST (the SQL text used to fill the
// 500-char sample before reaching it), never drizzle's `params:` line or a connection string, and every
// other error's message unchanged.

// A driver error as Neon's NeonDbError / PGlite raise it: an Error carrying the Postgres fields.
function pgError(message: string, fields: Record<string, string> = {}): Error {
  return Object.assign(new Error(message), fields);
}

const INSERT_SQL = `insert into "jobs" (${'"id", '.repeat(40)}"title") values ($1, $2) on conflict do update`;

describe("describeDbError", () => {
  it("puts a failed query's Postgres reason first and drops the params line", () => {
    const cause = pgError(
      'duplicate key value violates unique constraint "jobs_source_external_id_uq"',
      {
        code: "23505",
        table: "jobs",
        constraint: "jobs_source_external_id_uq",
        detail: "Key (source, external_id)=(greenhouse, 4242) already exists.",
      },
    );
    const err = new DrizzleQueryError(INSERT_SQL, ["Senior Engineer", "secret-job-text"], cause);
    expect(err.message).toContain("\nparams: "); // the real drizzle shape this guards against

    const text = describeDbError(err);

    expect(text).toBe(
      "[code=23505 table=jobs constraint=jobs_source_external_id_uq] duplicate key value violates " +
        `unique constraint "jobs_source_external_id_uq" | ${`Failed query: ${INSERT_SQL}`.slice(0, 100)}`,
    );
    expect(text).not.toMatch(/params|secret-job-text|already exists/); // no params, no `detail` row values
  });

  it("keeps only the cause's first line, capped", () => {
    const cause = pgError(`${"x".repeat(300)}\n    at stack frame`);
    const text = describeDbError(new DrizzleQueryError("select 1", [], cause));
    expect(text).toBe(`${"x".repeat(200)} | Failed query: select 1`);
  });

  it("redacts a URL-like token in the cause down to its scheme", () => {
    const cause = pgError(
      "Error connecting to database: postgresql://neondb_owner:s3cret@ep-x.neon.tech/neondb?sslmode=require " +
        "via https://ep-x.neon.tech/sql",
    );
    expect(describeDbError(new DrizzleQueryError("select 1", [], cause))).toBe(
      "Error connecting to database: postgresql://[redacted] via https://[redacted] | Failed query: select 1",
    );
  });

  it("redacts a libpq keyword-form password, bare or quoted", () => {
    const cause = pgError(
      "connection failed: host=ep-x.neon.tech user=neondb_owner password=s3cret dbname=neondb " +
        "PASSWORD = 'two words'",
    );
    expect(describeDbError(new DrizzleQueryError("select 1", [], cause))).toBe(
      "connection failed: host=ep-x.neon.tech user=neondb_owner password=[redacted] dbname=neondb " +
        "PASSWORD=[redacted] | Failed query: select 1",
    );
  });

  it("keeps the SQL of a multi-line `sql` template that starts with a newline, whitespace collapsed", () => {
    // As drizzle renders lifecycle.ts's `db.execute(sql\`\n    UPDATE …\`)`: the first line is empty.
    const query =
      "\n    UPDATE jobs SET lifecycle_state = 'closed'\n    WHERE id = ANY($1::int[])\n  ";
    const err = new DrizzleQueryError(
      query,
      ["{1,2,3}"],
      pgError("canceling statement", { code: "57014" }),
    );
    expect(describeDbError(err)).toBe(
      "[code=57014] canceling statement | " +
        "Failed query: UPDATE jobs SET lifecycle_state = 'closed' WHERE id = ANY($1::int[])",
    );
  });

  it("drops the params line even without a cause", () => {
    const err = new DrizzleQueryError("select $1", ["secret-job-text"]);
    expect(describeDbError(err)).toBe("Failed query: select $1");
  });

  it("returns any other error's message unchanged — a cause included (an adapter's rate limit)", () => {
    const plain = new Error("HTTP 404 for https://boards-api.greenhouse.io/v1/boards/acme/jobs");
    expect(describeDbError(plain)).toBe(plain.message);
    const wrapped = new Error('workable "wa" rate-limited: 429', {
      cause: new Error("fetch failed: 429"),
    });
    expect(describeDbError(wrapped)).toBe(wrapped.message);
    expect(describeDbError("boom")).toBe("boom");
  });
});
