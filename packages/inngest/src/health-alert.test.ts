/**
 * Unit suite for the shared health-ALERT orchestration (src/health-alert.ts `alertOnHealth` +
 * `getHealthAlertCooldownH`). NO creds, NO Postgres, NO email — a fake Db (queued shouldNotify counts +
 * captured recordHealthAlert rows) and a fake send seam drive it. Locks: no enforce firing ⇒ no-op; a clear
 * firing pages once + records one shape-only row; a firing within cooldown is suppressed; mixed sends ONE
 * batched email naming only the cleared check(s) + a suppressed note; the read→send→record ORDER (a failed
 * send leaves the cooldown un-armed); and the env cooldown parse.
 */
import { describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import type { HealthCheck, HealthCheckId, HealthReport } from "@opusfinder/db/health";

import { alertOnHealth, getHealthAlertCooldownH } from "./health-alert";

const COST: HealthReport["cost"] = {
  digestsConsidered: 0,
  rerankCacheReadTokens: 0,
  rerankCacheCreationTokens: 0,
  rerankCacheHitRate: null,
};

function check(id: HealthCheckId, mode: HealthCheck["mode"], state: HealthCheck["state"]): HealthCheck {
  return { id, label: id, state, metric: 4.2, threshold: 3, mode };
}

function report(checks: HealthCheck[]): HealthReport {
  return {
    checks,
    cost: COST,
    unhealthy: checks.some((c) => c.mode === "enforce" && c.state === "firing"),
  };
}

/** Fake Db: `shouldNotify` reads the next queued recent-row count (per firing check, in order);
 *  `recordHealthAlert` appends its `.values()` row. No rendering ⇒ no drizzle import. */
function stubDb(recentQueue: number[]): { db: Db; inserted: Record<string, unknown>[] } {
  const inserted: Record<string, unknown>[] = [];
  let i = 0;
  const db = {
    insert: () => ({ values: async (row: Record<string, unknown>) => void inserted.push(row) }),
    execute: async () => [{ n: recentQueue[i++] ?? 0 }],
  } as unknown as Db;
  return { db, inserted };
}

function stubSend(): {
  send: (subject: string, text: string) => Promise<{ emailId: string }>;
  sends: { subject: string; text: string }[];
} {
  const sends: { subject: string; text: string }[] = [];
  return {
    sends,
    send: async (subject, text) => {
      sends.push({ subject, text });
      return { emailId: `em-${sends.length}` };
    },
  };
}

describe("alertOnHealth", () => {
  it("is a no-op when nothing is enforce-firing (a shadow firing + ok checks)", async () => {
    const { db, inserted } = stubDb([0]);
    const { send, sends } = stubSend();

    const out = await alertOnHealth(
      db,
      report([check("ingestion_staleness", "shadow", "firing"), check("board_fail_ratio", "enforce", "ok")]),
      send,
      24,
    );

    expect(sends).toHaveLength(0);
    expect(inserted).toHaveLength(0);
    expect(out.firing).toHaveLength(0);
    expect(out.notified).toHaveLength(0);
    expect(out.emailId).toBeUndefined();
  });

  it("pages once + records one shape-only row for a firing clear of the cooldown", async () => {
    const { db, inserted } = stubDb([0]); // recent=0 ⇒ clear
    const { send, sends } = stubSend();

    const out = await alertOnHealth(db, report([check("ingestion_staleness", "enforce", "firing")]), send, 24);

    expect(sends).toHaveLength(1);
    expect(sends[0]!.subject).toContain("1 check(s) firing");
    expect(sends[0]!.text).toContain("ingestion_staleness");
    expect(sends[0]!.text).toContain("Shape-only");
    expect(sends[0]!.text).not.toContain("@"); // no address leak
    expect(sends[0]!.text).not.toContain("http"); // no url leak
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.checkId).toBe("ingestion_staleness");
    expect(out.notified.map((c) => c.id)).toEqual(["ingestion_staleness"]);
    expect(out.suppressed).toHaveLength(0);
    expect(out.emailId).toBe("em-1");
  });

  it("suppresses a firing within the cooldown — no send, no row", async () => {
    const { db, inserted } = stubDb([1]); // recent=1 ⇒ within cooldown
    const { send, sends } = stubSend();

    const out = await alertOnHealth(db, report([check("ingestion_staleness", "enforce", "firing")]), send, 24);

    expect(sends).toHaveLength(0);
    expect(inserted).toHaveLength(0);
    expect(out.notified).toHaveLength(0);
    expect(out.suppressed.map((c) => c.id)).toEqual(["ingestion_staleness"]);
    expect(out.emailId).toBeUndefined();
  });

  it("mixed: one batched email naming only the cleared check + a suppressed note, one row", async () => {
    const { db, inserted } = stubDb([0, 1]); // firing order [A clear, B within-cooldown]
    const { send, sends } = stubSend();

    const out = await alertOnHealth(
      db,
      report([
        check("ingestion_staleness", "enforce", "firing"),
        check("board_fail_ratio", "enforce", "firing"),
      ]),
      send,
      24,
    );

    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).toContain("ingestion_staleness"); // cleared
    expect(sends[0]!.text).not.toContain("board_fail_ratio"); // suppressed — not named
    expect(sends[0]!.text).toContain("1 further firing check(s) suppressed");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.checkId).toBe("ingestion_staleness");
    expect(out.notified).toHaveLength(1);
    expect(out.suppressed).toHaveLength(1);
  });

  it("a FAILED send propagates AND leaves the cooldown un-armed (read→send→record order)", async () => {
    // The load-bearing dedup invariant: record ONLY after a successful send, else a failed page would
    // suppress a delivery that never happened → 24h of silence. Assert alertOnHealth rejects AND wrote no row.
    const { db, inserted } = stubDb([0]);
    const failingSend = async (): Promise<{ emailId: string }> => {
      throw new Error("resend alert send failed: rate_limited (status 429)");
    };

    await expect(
      alertOnHealth(db, report([check("ingestion_staleness", "enforce", "firing")]), failingSend, 24),
    ).rejects.toThrow(/rate_limited/);
    expect(inserted).toHaveLength(0);
  });

  it("renders null-metric ('no data') + boolean (no [threshold null]) checks without leaks, in email AND row", async () => {
    const { db, inserted } = stubDb([0, 0]);
    const { send, sends } = stubSend();
    const nullMetric: HealthCheck = {
      id: "ingestion_staleness",
      label: "Ingestion staleness",
      state: "firing",
      metric: null,
      threshold: 3,
      mode: "enforce",
    };
    const booleanCheck: HealthCheck = {
      id: "digest_health",
      label: "Digest health",
      state: "firing",
      metric: 2,
      threshold: null,
      mode: "enforce",
    };

    await alertOnHealth(db, report([nullMetric, booleanCheck]), send, 24);

    const text = sends[0]!.text;
    expect(text).toContain("no data");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("[threshold null]");
    // The persisted detail is the SAME shape-only line (email === health_alerts.detail).
    expect(inserted).toHaveLength(2);
    expect(inserted[1]!.detail as string).not.toContain("[threshold null]");
  });
});

describe("getHealthAlertCooldownH", () => {
  // env → parsed cooldown: unset/blank/negative/NaN all fall back to the default 24; a finite >=0 (incl.
  // explicit 0, which disables the cooldown) is honored.
  it.each([
    [{}, 24],
    [{ HEALTH_ALERT_COOLDOWN_H: "12" }, 12],
    [{ HEALTH_ALERT_COOLDOWN_H: "" }, 24],
    [{ HEALTH_ALERT_COOLDOWN_H: "-1" }, 24],
    [{ HEALTH_ALERT_COOLDOWN_H: "abc" }, 24],
    [{ HEALTH_ALERT_COOLDOWN_H: "0" }, 0],
  ])("parses %o → %i", (env, expected) => {
    expect(getHealthAlertCooldownH(env)).toBe(expected);
  });
});
