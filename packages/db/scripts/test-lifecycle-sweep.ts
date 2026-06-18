import { PgDialect } from "drizzle-orm/pg-core";

import { runScript } from "@opusfinder/shared/script";

import type { Db } from "../src/client";
import {
  ABSENCE_CLOSE_THRESHOLD,
  closeJobsForCompanies,
  sweepLifecycle,
} from "../src/repos/lifecycle";

/**
 * Stub smoke for `sweepLifecycle` (F2b) — the JS-decidable surface, NO creds, NO Postgres. A fake Db
 * records every `execute()` call and returns a canned aggregate row; the emitted SQL is rendered with
 * PgDialect so the branch shape is asserted without a live table. The SQL *semantics* (the increment /
 * close / revive transitions) are deterministic but only fully assertable against a real table — that is
 * the F2f live gate's job (PHASE_F2_PLAN.md §7/§9). Here we lock the safety-critical JS logic:
 *   - empty present-set is a HARD no-op (never touches the DB — decision 5);
 *   - count-only (shadow, default) SUPPRESSES the close write; enforce emits it;
 *   - bigint-as-string counts map to the SweepResult numbers;
 *   - NUL is stripped from external_ids before the jsonb param;
 *   - a custom threshold is honored.
 *
 *   pnpm --filter @opusfinder/db test:lifecycle
 */
const NUL = String.fromCharCode(0);
const dialect = new PgDialect();
const OK_ROW = [{ revived: "0", closed: "0", would_close: "0", swept: "0" }];

/** A fake Db that records execute() calls and returns a canned result — no Postgres, no creds. */
function stubDb(canned: unknown): { db: Db; calls: unknown[] } {
  const calls: unknown[] = [];
  const db = {
    execute: async (query: unknown) => {
      calls.push(query);
      return canned;
    },
  } as unknown as Db;
  return { db, calls };
}

function rendered(query: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]);
}

await runScript("test-lifecycle-sweep", async () => {
  // 1) Empty present-set is a HARD no-op — execute() must NOT be called (decision 5: `<> ALL('{}')`
  //    would close the whole board).
  {
    const { db, calls } = stubDb(OK_ROW);
    const r = await sweepLifecycle(db, 1, []);
    assert(calls.length === 0, "empty present-set must not hit the DB");
    assert(
      r.revived === 0 && r.swept === 0 && r.closed === 0 && r.wouldClose === 0,
      "empty present-set must return all zeros",
    );
  }

  // 2) Count-only (shadow, the default) SUPPRESSES the close write; the present set unnests from a jsonb
  //    param; the streak increments SQL-side; companyId + threshold are bound.
  {
    const { db, calls } = stubDb(OK_ROW);
    await sweepLifecycle(db, 7, ["a", "b"]);
    const { sql: text, params } = rendered(calls[0]);
    assert(!text.includes("THEN 'closed'"), "shadow (count-only) must NOT emit a close write");
    assert(
      text.includes("jsonb_array_elements_text"),
      "present set must unnest from a jsonb param",
    );
    assert(
      text.includes("consecutive_absences + 1"),
      "streak must increment SQL-side (no read-modify-write)",
    );
    assert(params.includes(7), "companyId must be bound");
    assert(params.includes(ABSENCE_CLOSE_THRESHOLD), "default threshold must be bound");
  }

  // 3) Enforce mode emits the close write.
  {
    const { db, calls } = stubDb(OK_ROW);
    await sweepLifecycle(db, 7, ["a"], { enforce: true });
    const { sql: text } = rendered(calls[0]);
    assert(text.includes("THEN 'closed'"), "enforce mode must emit the close write");
  }

  // 3a) closed_at clock (G2a), Arm A: the revive-clear (present → NULL) is ALWAYS emitted (shadow AND
  //     enforce — the invariant "closed_at non-NULL iff currently closed" holds regardless of mode); the
  //     close-stamp (THEN now()) is enforce-ONLY, in lockstep with the 'closed' write. `THEN now()` is
  //     distinct from `updated_at = now()`, so it cleanly detects the stamp branch.
  {
    const { db, calls } = stubDb(OK_ROW); // shadow (default)
    await sweepLifecycle(db, 7, ["a"]);
    const { sql: text } = rendered(calls[0]);
    assert(text.includes("closed_at = CASE"), "Arm A must maintain the closed_at clock");
    assert(text.includes("THEN NULL"), "Arm A must clear closed_at to NULL on revive");
    assert(!text.includes("THEN now()"), "shadow must NOT stamp closed_at (no close → no stamp)");
  }
  {
    const { db, calls } = stubDb(OK_ROW); // enforce
    await sweepLifecycle(db, 7, ["a"], { enforce: true });
    const { sql: text } = rendered(calls[0]);
    assert(text.includes("THEN NULL"), "enforce Arm A must still clear closed_at on revive");
    // LOCKSTEP (decision 4 — the load-bearing invariant for the IRREVERSIBLE prune): the closed_at stamp
    // must ride the SAME `consecutive_absences + 1 >= threshold` predicate as the 'closed' write, not
    // merely exist. A stamp on a looser/wrong/unconditional predicate would still emit `THEN now()` yet
    // desync closed_at from lifecycle_state and poison the prune's `closed_at < now() - 30d` window. The
    // regexes require each `THEN` target to be guarded by the threshold predicate; the count requires BOTH
    // branches (closeBranch + closedAtBranch) to use it.
    assert(
      /consecutive_absences \+ 1 >= \$\d+ THEN 'closed'/.test(text),
      "enforce close write must be guarded by the +1>=threshold predicate",
    );
    assert(
      /consecutive_absences \+ 1 >= \$\d+ THEN now\(\)/.test(text),
      "enforce closed_at stamp must ride the SAME +1>=threshold predicate as the close write",
    );
    assert(
      (text.match(/consecutive_absences \+ 1 >= /g) ?? []).length >= 2,
      "both the 'closed' write and the closed_at stamp must use the +1>=threshold guard (lockstep)",
    );
  }

  // 4) bigint-as-string aggregate row maps to SweepResult numbers.
  {
    const { db } = stubDb([{ revived: "2", closed: "1", would_close: "4", swept: "3" }]);
    const r = await sweepLifecycle(db, 7, ["a"], { enforce: true });
    assert(
      r.revived === 2 && r.closed === 1 && r.wouldClose === 4 && r.swept === 3,
      `result mapping wrong: ${JSON.stringify(r)}`,
    );
  }

  // 5) NUL is stripped from external_ids before the jsonb param (jsonb rejects a NUL byte).
  {
    const { db, calls } = stubDb(OK_ROW);
    await sweepLifecycle(db, 7, [`job${NUL}1`, "clean2"]);
    const { params } = rendered(calls[0]);
    const jsonParam = params.find((p) => typeof p === "string" && p.includes("job")) as
      | string
      | undefined;
    assert(jsonParam !== undefined, "present-set json param not found");
    assert(!jsonParam.includes(NUL), "NUL must be stripped from the present-set param");
    assert((JSON.parse(jsonParam) as string[]).includes("job1"), "stripped id must be 'job1'");
  }

  // 6) A custom threshold is honored (bound into the SQL).
  {
    const { db, calls } = stubDb(OK_ROW);
    await sweepLifecycle(db, 7, ["a"], { threshold: 5 });
    const { params } = rendered(calls[0]);
    assert(params.includes(5), "custom threshold must be bound");
  }

  // 7) closeJobsForCompanies (Arm B): empty ids is an early-out — never hits the DB.
  {
    const { db, calls } = stubDb([{ would_close: "9" }]);
    const r = await closeJobsForCompanies(db, []);
    assert(calls.length === 0, "empty companyIds must not hit the DB");
    assert(r.closed === 0 && r.wouldClose === 0, "empty companyIds must return zeros");
  }

  // 8) Arm B shadow (default) COUNTS would-close, writes nothing; ids bind as an int[] literal.
  {
    const { db, calls } = stubDb([{ would_close: "5" }]);
    const r = await closeJobsForCompanies(db, [10, 20]);
    const { sql: text, params } = rendered(calls[0]);
    assert(!text.includes("UPDATE"), "shadow Arm B must NOT UPDATE");
    assert(text.includes("count(*)"), "shadow Arm B must count");
    assert(text.includes("::int[]"), "company ids must bind as an int[] literal");
    assert(
      params.some((p) => p === "{10,20}"),
      "the int[] literal must carry the company ids",
    );
    assert(r.closed === 0 && r.wouldClose === 5, `shadow Arm B result wrong: ${JSON.stringify(r)}`);
  }

  // 9) Arm B enforce UPDATEs to 'closed' AND stamps the closed_at clock (G2a); the closed count is the
  //    RETURNING row count.
  {
    const { db, calls } = stubDb([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const r = await closeJobsForCompanies(db, [10], { enforce: true });
    const { sql: text } = rendered(calls[0]);
    assert(
      text.includes("UPDATE") && text.includes("'closed'"),
      "enforce Arm B must write 'closed'",
    );
    assert(text.includes("closed_at = now()"), "enforce Arm B must stamp the closed_at clock");
    assert(
      r.closed === 3 && r.wouldClose === 0,
      `enforce Arm B result wrong: ${JSON.stringify(r)}`,
    );
  }

  console.log(
    "test-lifecycle-sweep OK — Arm A: empty no-op, shadow suppresses close, enforce closes, counts parsed, " +
      "NUL stripped, threshold honored, closed_at clock (clear-on-revive always / stamp-on-close enforce-only); " +
      "Arm B: empty early-out, shadow counts, enforce closes + stamps closed_at " +
      `(default threshold ${ABSENCE_CLOSE_THRESHOLD}).`,
  );
});

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
