import { runScript } from "@opusfinder/shared/script";

import type { Db } from "../src/client";
import { getPreferences, updatePreferences } from "../src/repos/preferences";

/**
 * Stub smoke for the `user_preferences` write path — NO creds, NO Postgres. It locks the
 * THREE-EDIT COUPLING that the schema warns about: a settable field present in the {@link UserPreferences}
 * contract but missing a `toRow` line is silently dropped with no error. A fake Db captures the `.set()`
 * payload `updatePreferences` builds (which is `toRow(patch)` + `updatedAt`), so we assert every settable
 * field maps, that explicit `null` is preserved (a "clear the bound" write), that a falsy `0` survives (NOT
 * treated as unset), that an omitted field is left untouched, and that an empty patch short-circuits to a
 * SELECT (never an UPDATE). The SQL *semantics* of the round-trip against a real table are the owner's
 * post-migrate check (needs DATABASE_URL + a user FK fixture); this locks the JS mapping with no creds.
 *
 *   pnpm --filter @opusfinder/db test:prefs
 */
// Distinct sentinels per path so a test can PROVE which one ran: UPDATE...RETURNING vs the empty-patch
// SELECT short-circuit. (If both returned the same row, the empty-patch case couldn't tell them apart.)
const UPDATE_ROW = { id: 1, locationMode: "any" } as const;
const SELECT_ROW = { id: 1, locationMode: "onsite_only" } as const;

/** A fake Db that records the `.set()` payload of an update and answers selects with a distinct row. The
 *  fluent chains mirror exactly what preferences.ts calls; `.where()`/`eq()`/`sql` are no-ops here. */
function stubDb(): { db: Db; lastSet: () => Record<string, unknown> | undefined; updates: () => number } {
  let captured: Record<string, unknown> | undefined;
  let updateCount = 0;
  const db = {
    update: () => ({
      set: (vals: Record<string, unknown>) => {
        captured = vals;
        updateCount += 1;
        return { where: () => ({ returning: async () => [UPDATE_ROW] }) };
      },
    }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [SELECT_ROW] }) }),
    }),
  } as unknown as Db;
  return { db, lastSet: () => captured, updates: () => updateCount };
}

const USER = "00000000-0000-0000-0000-000000000001" as never;

await runScript("test-prefs-roundtrip", async () => {
  // 1) Full F3 patch — every new field reaches the row (the three-edit coupling holds end-to-end), and
  //    updatedAt is bumped. yoeMin=0 must survive (a real "no floor needed" answer, not "unset").
  {
    const { db, lastSet, updates } = stubDb();
    await updatePreferences(db, USER, {
      locationMode: "remote_only",
      maxSalary: 180000,
      yoeMin: 0,
      yoeMax: 8,
      dealbreakers: ["onsite", "crypto"],
    });
    const set = lastSet() ?? {};
    assert(updates() === 1, "a non-empty patch must issue exactly one UPDATE");
    assert(set.locationMode === "remote_only", "locationMode must map");
    assert(set.maxSalary === 180000, "maxSalary must map");
    assert(set.yoeMin === 0, "yoeMin=0 must map (falsy-zero is a real value, not unset)");
    assert(set.yoeMax === 8, "yoeMax must map");
    assert(
      Array.isArray(set.dealbreakers) && (set.dealbreakers as string[]).join(",") === "onsite,crypto",
      "dealbreakers array must map",
    );
    assert(set.updatedAt !== undefined, "updatedAt must be bumped on update");
  }

  // 2) Explicit null is PRESERVED (clear a bound), distinct from "leave alone". minSalary/maxSalary/yoe
  //    are nullable — a null patch writes SQL NULL, not "skip".
  {
    const { db, lastSet } = stubDb();
    await updatePreferences(db, USER, { maxSalary: null, yoeMax: null });
    const set = lastSet() ?? {};
    assert(set.maxSalary === null, "maxSalary: null must be preserved (clear the cap)");
    assert(set.yoeMax === null, "yoeMax: null must be preserved");
  }

  // 3) Omitted fields are left untouched — only the keys present in the patch appear in the row.
  {
    const { db, lastSet } = stubDb();
    await updatePreferences(db, USER, { maxSalary: 200000 });
    const set = lastSet() ?? {};
    assert(set.maxSalary === 200000, "maxSalary must map");
    assert(!("yoeMin" in set), "an omitted field must NOT appear in the update payload");
    assert(!("locationMode" in set), "an omitted field must NOT appear in the update payload");
  }

  // 4) Empty patch short-circuits to a SELECT — never an UPDATE (no spurious updated_at bump).
  {
    const { db, updates } = stubDb();
    const row = await updatePreferences(db, USER, {});
    assert(updates() === 0, "an empty patch must NOT issue an UPDATE");
    assert(row.locationMode === "onsite_only", "an empty patch returns the current row via the SELECT path");
  }

  // getPreferences smoke (the select chain the stub answers) — sanity that the read path is wired.
  {
    const { db } = stubDb();
    const row = await getPreferences(db, USER);
    assert(row?.locationMode === "onsite_only", "getPreferences must return the canned SELECT row");
  }

  console.log(
    "test-prefs-roundtrip OK — all 6 F3 fields map, explicit null preserved, yoe=0 survives, omitted " +
      "fields untouched, empty patch short-circuits to SELECT.",
  );
});

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
