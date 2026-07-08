import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { render } from "@test/db/render";

import type { Db } from "../client";
import {
  getOrCreatePreferences,
  getPreferences,
  setDigestApproval,
  updatePreferences,
} from "./preferences";
import type { UserPreferencesRow } from "./preferences";

// Leaf pure-unit for the `user_preferences` repo (offline, deterministic — no DB, no creds). Ports
// scripts/test-prefs-roundtrip.ts and extends it to the create/upsert and digest-approval write paths.
// Unlike the raw-SQL repos (which emit `db.execute(sql`...`)`), these functions drive the TYPED query
// BUILDER, so a local fake captures the `.set()` / `.values()` payloads and the async terminals resolve
// to CONFIGURABLE canned rows. This locks the JS field mapping (`toRow`, the three-edit coupling), the
// falsy-zero survival, explicit-null preservation, the empty-patch short-circuit, the fresh-create vs
// conflict fallback, and the COALESCE-vs-null digest-approval branch. Real SQL semantics are the PGlite
// gate's job.

// Distinct sentinels per path so a test can PROVE which chain answered: UPDATE...RETURNING vs the
// SELECT short-circuit vs INSERT...RETURNING. Cast to the row type (reference identity is all we assert;
// the field shapes are irrelevant to these builder-level tests).
const UPDATE_ROW = { id: 1, locationMode: "any", _path: "update" } as unknown as UserPreferencesRow;
const SELECT_ROW = {
  id: 2,
  locationMode: "onsite_only",
  unsubscribeToken: "existing-token",
  _path: "select",
} as unknown as UserPreferencesRow;
const INSERT_ROW = {
  id: 3,
  locationMode: "remote_only",
  unsubscribeToken: "inserted-token",
  _path: "insert",
} as unknown as UserPreferencesRow;

interface StubOptions {
  /** Rows resolved by `update().set().where().returning()` (default `[UPDATE_ROW]`). */
  updateReturning?: unknown[];
  /** Rows resolved by `select().from().where().limit()` (default `[SELECT_ROW]`). */
  selectRows?: unknown[];
  /** Rows resolved by `insert().values().onConflictDoNothing().returning()` (default `[INSERT_ROW]`). */
  insertReturning?: unknown[];
}

interface Stub {
  db: Db;
  /** The payload passed to the last `.set(...)` (i.e. `toRow(patch)` + `updatedAt`), or undefined. */
  set: () => Record<string, unknown> | undefined;
  /** The payload passed to the last `.values(...)` on an insert, or undefined. */
  insertValues: () => Record<string, unknown> | undefined;
  /**
   * The predicate handed to the last `.where(...)` on either the UPDATE or SELECT chain — a drizzle
   * `SQL` from `eq(userPreferences.userId, userId)`. Captured so a test can `render()` it and PROVE the
   * write/read is user-scoped; without this a repo that dropped its `.where(...)` (updating EVERY row)
   * would still pass. Undefined until a `.where(...)` runs.
   */
  where: () => unknown;
  updates: () => number;
  inserts: () => number;
  selects: () => number;
}

/**
 * A fake Db whose typed query-builder chains mirror EXACTLY what preferences.ts calls. `.set()` /
 * `.values()` capture their payloads; the async terminals (`.returning()`, `.limit()`) resolve to the
 * configured canned rows so a single stub can drive both the fresh-create and the conflict fallback.
 * `.where(pred)` captures its predicate (the real `eq(...)` SQL) so a test can render + assert the
 * user scoping; `eq()` / `sql` themselves are the production drizzle builders, untouched here.
 */
function stubDb(opts: StubOptions = {}): Stub {
  const updateReturning = opts.updateReturning ?? [UPDATE_ROW];
  const selectRows = opts.selectRows ?? [SELECT_ROW];
  const insertReturning = opts.insertReturning ?? [INSERT_ROW];

  let capturedSet: Record<string, unknown> | undefined;
  let capturedInsert: Record<string, unknown> | undefined;
  let capturedWhere: unknown;
  let updateCount = 0;
  let insertCount = 0;
  let selectCount = 0;

  const db = {
    update: () => ({
      set: (vals: Record<string, unknown>) => {
        capturedSet = vals;
        updateCount += 1;
        return {
          where: (pred: unknown) => {
            capturedWhere = pred;
            return { returning: async () => updateReturning };
          },
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: (pred: unknown) => {
          capturedWhere = pred;
          return {
            limit: async () => {
              selectCount += 1;
              return selectRows;
            },
          };
        },
      }),
    }),
    insert: () => ({
      values: (vals: Record<string, unknown>) => {
        capturedInsert = vals;
        insertCount += 1;
        return { onConflictDoNothing: () => ({ returning: async () => insertReturning }) };
      },
    }),
  } as unknown as Db;

  return {
    db,
    set: () => capturedSet,
    insertValues: () => capturedInsert,
    where: () => capturedWhere,
    updates: () => updateCount,
    inserts: () => insertCount,
    selects: () => selectCount,
  };
}

const USER = "00000000-0000-0000-0000-000000000001" as never;

describe("updatePreferences — patches only the settable subset via toRow", () => {
  it("full F3 patch maps ALL 11 settable columns, bumps updatedAt, keeps yoeMin=0, issues exactly one UPDATE", async () => {
    const stub = stubDb();
    // Every settable column toRow maps, each with a DISTINCT value, so a mis-wired mapping (dropped or
    // cross-assigned column) can't hide behind a partial patch.
    const row = await updatePreferences(stub.db, USER, {
      locationMode: "remote_only",
      locations: ["nyc", "sf"],
      minSalary: 90000,
      maxSalary: 180000,
      yoeMin: 0,
      yoeMax: 8,
      recencyDays: 30,
      exclusions: ["contract"],
      dealbreakers: ["onsite", "crypto"],
      digestCadence: "daily",
      digestEnabled: false,
    });
    const set = stub.set()!;

    expect(stub.updates()).toBe(1);
    expect(set.locationMode).toBe("remote_only");
    expect(set.locations).toEqual(["nyc", "sf"]);
    expect(set.minSalary).toBe(90000);
    expect(set.maxSalary).toBe(180000);
    // Falsy-zero is a REAL value ("no floor needed"), not "unset" — it must survive the toRow map.
    expect(set.yoeMin).toBe(0);
    expect(set.yoeMax).toBe(8);
    expect(set.recencyDays).toBe(30);
    expect(set.exclusions).toEqual(["contract"]);
    expect(set.dealbreakers).toEqual(["onsite", "crypto"]);
    expect(set.digestCadence).toBe("daily");
    // Falsy-false is a REAL value ("digest off"), not "unset" — it must survive the toRow map too.
    expect(set.digestEnabled).toBe(false);
    // updatedAt is bumped (a drizzle `sql`now()`` object) on every real update.
    expect(set.updatedAt).toBeDefined();
    // The UPDATE is user-scoped: a repo that dropped `.where(eq(userPreferences.userId, userId))` would
    // rewrite EVERY row. Render the captured predicate and prove it binds THIS user's id on user_id.
    const where = render(stub.where() as SQL);
    expect(where.sql).toContain("user_id");
    expect(where.params).toContain(USER);
    // Returns the UPDATE...RETURNING row, not the SELECT short-circuit row.
    expect(row).toBe(UPDATE_ROW);
  });

  it("explicit null is PRESERVED (clear a bound), distinct from omitted", async () => {
    const stub = stubDb();
    await updatePreferences(stub.db, USER, { minSalary: null, maxSalary: null, yoeMax: null });
    const set = stub.set()!;

    // `minSalary: null` is the case toRow explicitly documents ("an explicit no floor") — it must land
    // as literal null, not be dropped like `undefined`.
    expect(set.minSalary).toBeNull();
    expect(set.maxSalary).toBeNull();
    expect(set.yoeMax).toBeNull();
  });

  it("omitted fields never appear in the SET payload", async () => {
    const stub = stubDb();
    await updatePreferences(stub.db, USER, { maxSalary: 200000 });
    const set = stub.set()!;

    expect(set.maxSalary).toBe(200000);
    expect(set).not.toHaveProperty("yoeMin");
    expect(set).not.toHaveProperty("locationMode");
  });

  it("empty patch short-circuits to the SELECT — no UPDATE, returns the current row", async () => {
    const stub = stubDb();
    const row = await updatePreferences(stub.db, USER, {});

    expect(stub.updates()).toBe(0);
    expect(stub.set()).toBeUndefined();
    expect(row).toBe(SELECT_ROW);
  });

  it("throws when the row is missing (UPDATE...RETURNING is empty)", async () => {
    const stub = stubDb({ updateReturning: [] });
    await expect(updatePreferences(stub.db, USER, { maxSalary: 1 })).rejects.toThrow(
      /no preferences row/,
    );
  });
});

describe("getPreferences — read path", () => {
  it("returns the canned SELECT row, scoped to the target user", async () => {
    const stub = stubDb();
    const row = await getPreferences(stub.db, USER);
    expect(row).toBe(SELECT_ROW);
    // The read is user-scoped: a repo that dropped `.where(eq(userPreferences.userId, userId))` would
    // read the first arbitrary row. Render the captured predicate and prove it binds THIS user's id.
    const where = render(stub.where() as SQL);
    expect(where.sql).toContain("user_id");
    expect(where.params).toContain(USER);
  });

  it("returns null when no row exists (empty SELECT)", async () => {
    const stub = stubDb({ selectRows: [] });
    const row = await getPreferences(stub.db, USER);
    expect(row).toBeNull();
  });
});

describe("getOrCreatePreferences — idempotent create on user_id", () => {
  it("fresh create inserts userId + unsubscribeToken + toRow(prefs) and returns the inserted row", async () => {
    const stub = stubDb();
    const row = await getOrCreatePreferences(stub.db, {
      userId: USER,
      unsubscribeToken: "tok-fresh",
      prefs: { locationMode: "remote_only", yoeMin: 3 },
    });
    const values = stub.insertValues()!;

    expect(values.userId).toBe(USER);
    expect(values.unsubscribeToken).toBe("tok-fresh");
    // Spread from toRow(prefs) — same field mapping as updatePreferences.
    expect(values.locationMode).toBe("remote_only");
    expect(values.yoeMin).toBe(3);
    expect(stub.inserts()).toBe(1);
    expect(row).toBe(INSERT_ROW);
    // A successful INSERT...RETURNING never falls back to the SELECT.
    expect(stub.selects()).toBe(0);
  });

  it("conflict returns the EXISTING row via fallback SELECT (token NOT rotated, no UPDATE)", async () => {
    // onConflictDoNothing().returning() resolves [] → the existing row is the source of truth.
    const stub = stubDb({ insertReturning: [], selectRows: [SELECT_ROW] });
    const row = await getOrCreatePreferences(stub.db, {
      userId: USER,
      unsubscribeToken: "tok-rotate-attempt",
      prefs: {},
    });

    // Returns the pre-existing SELECT_ROW (whose token is untouched), NOT the attempted insert values.
    expect(row).toBe(SELECT_ROW);
    expect(stub.selects()).toBe(1);
    expect(stub.updates()).toBe(0); // never rotates the token / patches the row
  });

  it("throws when BOTH insert-returning and fallback-select are empty", async () => {
    const stub = stubDb({ insertReturning: [], selectRows: [] });
    await expect(
      getOrCreatePreferences(stub.db, { userId: USER, unsubscribeToken: "tok", prefs: {} }),
    ).rejects.toThrow(/no row after upsert/);
  });
});

describe("setDigestApproval — the operator digest send permit", () => {
  it("approve=true stamps a drizzle COALESCE object (opaque, non-null), bumps updatedAt", async () => {
    const stub = stubDb();
    const row = await setDigestApproval(stub.db, USER, true);
    const set = stub.set()!;

    // COALESCE(digest_approved_at, now()) is an opaque drizzle SQL object — not a literal, not null.
    expect(set.digestApprovedAt).not.toBeNull();
    expect(typeof set.digestApprovedAt).toBe("object");
    // Render the fragment: a regression from COALESCE to a bare now() would OVERWRITE the original grant
    // instant (destroying the audit timestamp) yet still be a non-null object — so `typeof === "object"`
    // alone ships that green. Lock the COALESCE-onto-existing shape structurally.
    const q = render(set.digestApprovedAt as SQL);
    expect(q.sql.toLowerCase()).toContain("coalesce");
    expect(q.sql).toContain("digest_approved_at");
    expect(q.sql.toLowerCase()).toContain("now()");
    expect(set.updatedAt).toBeDefined();
    expect(stub.updates()).toBe(1);
    // The permit write is user-scoped: dropping `.where(eq(userPreferences.userId, userId))` would
    // approve EVERY user. Render the captured predicate and prove it binds THIS user's id on user_id.
    const where = render(stub.where() as SQL);
    expect(where.sql).toContain("user_id");
    expect(where.params).toContain(USER);
    expect(row).toBe(UPDATE_ROW);
  });

  it("approve=false clears the permit to literal NULL (fail-closed)", async () => {
    const stub = stubDb();
    await setDigestApproval(stub.db, USER, false);
    const set = stub.set()!;

    expect(set.digestApprovedAt).toBeNull();
  });

  it("throws when the row is missing (UPDATE...RETURNING is empty)", async () => {
    const stub = stubDb({ updateReturning: [] });
    await expect(setDigestApproval(stub.db, USER, true)).rejects.toThrow(/no preferences row/);
  });
});
