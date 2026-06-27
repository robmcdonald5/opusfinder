import { type HealthCheck, type HealthCheckId, type HealthReport } from "@opusfinder/db/health";
import { runScript } from "@opusfinder/shared/script";

import { alertOnHealth, getHealthAlertCooldownH } from "../src/health-alert.ts";

/**
 * Smoke (NO creds, NO Postgres, NO email) for the shared health-ALERT orchestration. A fake Db returns
 * a queued recent-row count per `shouldNotify` call (in firing-check order) and captures `recordHealthAlert`
 * rows; a fake `send` captures the one batched email. Asserts:
 *   - a report with no ENFORCE firing ⇒ no send, no record;
 *   - one enforce firing clear of the cooldown ⇒ one shape-only email + one row, notified=[it];
 *   - the same firing within the cooldown ⇒ no send, no row, suppressed=[it];
 *   - mixed (one clear, one suppressed) ⇒ one email naming only the clear one + a "suppressed" note, one row;
 *   - getHealthAlertCooldownH parses env (default / override / blank / negative / NaN).
 *
 *   pnpm --filter @opusfinder/inngest test:health-alert
 */
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
  return { checks, cost: COST, unhealthy: checks.some((c) => c.mode === "enforce" && c.state === "firing") };
}

/** Fake Db: `shouldNotify` reads the next queued count (per firing check, in order); `recordHealthAlert`
 *  appends its `.values()` row. No rendering ⇒ no drizzle import / phantom dep. */
function stubDb(recentQueue: number[]): {
  db: import("@opusfinder/db").Db;
  inserted: Array<Record<string, unknown>>;
} {
  const inserted: Array<Record<string, unknown>> = [];
  let i = 0;
  const db = {
    insert: () => ({ values: async (row: Record<string, unknown>) => void inserted.push(row) }),
    execute: async () => [{ n: recentQueue[i++] ?? 0 }],
  } as unknown as import("@opusfinder/db").Db;
  return { db, inserted };
}

function stubSend(): {
  send: (subject: string, text: string) => Promise<{ emailId: string }>;
  sends: Array<{ subject: string; text: string }>;
} {
  const sends: Array<{ subject: string; text: string }> = [];
  return {
    sends,
    send: async (subject, text) => {
      sends.push({ subject, text });
      return { emailId: `em-${sends.length}` };
    },
  };
}

await runScript("test-health-alert", async () => {
  // 1) Nothing enforce-firing (a shadow firing + ok checks) ⇒ no send, no record.
  {
    const { db, inserted } = stubDb([0]);
    const { send, sends } = stubSend();
    const out = await alertOnHealth(
      db,
      report([check("ingestion_staleness", "shadow", "firing"), check("board_fail_ratio", "enforce", "ok")]),
      send,
      24,
    );
    assert(sends.length === 0, "no enforce firing ⇒ no email");
    assert(inserted.length === 0, "no enforce firing ⇒ no health_alerts row");
    assert(out.notified.length === 0 && out.firing.length === 0 && out.emailId === undefined, "outcome is empty");
  }

  // 2) One enforce firing, cooldown CLEAR (recent=0) ⇒ one shape-only email + one row.
  {
    const { db, inserted } = stubDb([0]);
    const { send, sends } = stubSend();
    const out = await alertOnHealth(db, report([check("ingestion_staleness", "enforce", "firing")]), send, 24);
    assert(sends.length === 1, "a clear enforce firing pages once");
    assert(sends[0]!.subject.includes("1 check(s) firing"), "subject names the count");
    assert(sends[0]!.text.includes("ingestion_staleness"), "body names the firing check");
    assert(sends[0]!.text.includes("Shape-only"), "body keeps the shape-only footer");
    assert(!sends[0]!.text.includes("@") && !sends[0]!.text.includes("http"), "body leaks no address/url");
    assert(inserted.length === 1 && inserted[0]!.checkId === "ingestion_staleness", "records exactly one row");
    assert(out.notified.map((c) => c.id).join() === "ingestion_staleness", "notified is the firing check");
    assert(out.suppressed.length === 0 && out.emailId === "em-1", "nothing suppressed; emailId returned");
  }

  // 3) Same enforce firing but WITHIN cooldown (recent=1) ⇒ suppressed: no send, no row.
  {
    const { db, inserted } = stubDb([1]);
    const { send, sends } = stubSend();
    const out = await alertOnHealth(db, report([check("ingestion_staleness", "enforce", "firing")]), send, 24);
    assert(sends.length === 0, "a firing within cooldown does not re-page");
    assert(inserted.length === 0, "a suppressed firing writes no row");
    assert(out.notified.length === 0 && out.suppressed.map((c) => c.id).join() === "ingestion_staleness", "suppressed");
    assert(out.emailId === undefined, "no email id when nothing paged");
  }

  // 4) Mixed: A clear (recent=0) + B within cooldown (recent=1) ⇒ ONE email naming only A + a suppressed
  //    note; only A recorded. (Queue order = firing-check order = [A, B].)
  {
    const { db, inserted } = stubDb([0, 1]);
    const { send, sends } = stubSend();
    const out = await alertOnHealth(
      db,
      report([check("ingestion_staleness", "enforce", "firing"), check("board_fail_ratio", "enforce", "firing")]),
      send,
      24,
    );
    assert(sends.length === 1, "a single batched email for the checks clear of the cooldown");
    assert(sends[0]!.text.includes("ingestion_staleness"), "body names the cleared check");
    assert(!sends[0]!.text.includes("board_fail_ratio"), "body does NOT name the suppressed check");
    assert(sends[0]!.text.includes("1 further firing check(s) suppressed"), "body notes the suppressed count");
    assert(inserted.length === 1 && inserted[0]!.checkId === "ingestion_staleness", "records only the paged check");
    assert(out.notified.length === 1 && out.suppressed.length === 1, "one notified, one suppressed");
  }

  // 4b) The read→send→record ORDER is the load-bearing dedup invariant: a FAILED send must leave the
  //     cooldown UN-armed (no row) so the next run RETRIES the page — never record-then-fail (which would
  //     suppress a page that never delivered → 24h of silence). Assert alertOnHealth rejects AND wrote no row.
  {
    const { db, inserted } = stubDb([0]);
    const failingSend = async (): Promise<{ emailId: string }> => {
      throw new Error("resend alert send failed: rate_limited (status 429)");
    };
    let threw = false;
    try {
      await alertOnHealth(db, report([check("ingestion_staleness", "enforce", "firing")]), failingSend, 24);
    } catch {
      threw = true;
    }
    assert(threw, "a failed send must propagate (so the Inngest step retries / the CLI exits non-zero)");
    assert(inserted.length === 0, "a failed send must NOT arm the cooldown — no health_alerts row written");
  }

  // 4c) checkDetail/formatMetric render the null-metric ("no data") and boolean (threshold null ⇒ no
  //     suffix) branches — real states for digest_health / a never-run check — without NaN/undefined
  //     leaking into the email body OR the persisted health_alerts.detail.
  {
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
    assert(text.includes("no data"), "a null metric renders as 'no data'");
    assert(!text.includes("NaN") && !text.includes("undefined"), "no NaN/undefined leaks into the body");
    assert(!text.includes("[threshold null]"), "a boolean check (threshold null) renders no [threshold ...] suffix");
    assert(
      inserted.length === 2 && !(inserted[1]!.detail as string).includes("[threshold null]"),
      "the persisted detail is the same shape-only line (no [threshold null])",
    );
  }

  // 5) getHealthAlertCooldownH env parsing — default / override / blank / negative / NaN.
  {
    assert(getHealthAlertCooldownH({}) === 24, "unset ⇒ default 24");
    assert(getHealthAlertCooldownH({ HEALTH_ALERT_COOLDOWN_H: "12" }) === 12, "override honored");
    assert(getHealthAlertCooldownH({ HEALTH_ALERT_COOLDOWN_H: "" }) === 24, "blank ⇒ default");
    assert(getHealthAlertCooldownH({ HEALTH_ALERT_COOLDOWN_H: "-1" }) === 24, "negative rejected ⇒ default");
    assert(getHealthAlertCooldownH({ HEALTH_ALERT_COOLDOWN_H: "abc" }) === 24, "NaN rejected ⇒ default");
    assert(getHealthAlertCooldownH({ HEALTH_ALERT_COOLDOWN_H: "0" }) === 0, "explicit 0 disables the cooldown");
  }

  console.log(
    "test-health-alert OK — no enforce firing = no-op; a clear firing pages once + records one shape-only " +
      "row; a firing within cooldown is suppressed (no send, no row); mixed sends one batched email naming " +
      "only the cleared check(s) + a suppressed note; a FAILED send leaves the cooldown un-armed (no row); " +
      "null-metric/boolean checks render without NaN/[threshold null]; getHealthAlertCooldownH parses env.",
  );
});

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
