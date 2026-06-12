/**
 * Stub-seam smoke for the Phase-11 email-delivery tail (src/delivery.ts + @opusfinder/email) — NO
 * creds, NO network, NO real DB. Locks: render determinism + escaping, the ONE idempotency-key
 * shape, the full last_event→status mapping (incl. bounce→hard-suppress and complaint→suppress-
 * without-bounce), the allowlist fail-closed/skip behavior, and the step sequences of the failure /
 * skip / happy / slow-poll paths (driven through a fake `step` + a chainable-thenable stub Db).
 *
 *   pnpm --filter @opusfinder/inngest test:digest-email
 */
import type { Db } from "@opusfinder/db";
import type { DigestEmailPayload } from "@opusfinder/db/repos";
import { emailIdempotencyKey, renderDigestEmail, sendDigestEmail } from "@opusfinder/email";
import { runScript } from "@opusfinder/shared/script";
import type { UserId } from "@opusfinder/shared";

import {
  deliverDigestEmail,
  isTerminalEvent,
  mapDeliveryEvent,
  type DeliveryStepTools,
} from "../src/delivery.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function expectReject(p: Promise<unknown>, label: string): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error(`assertion failed: ${label} resolved but should have rejected`);
}

/** Hostile fixture — scraped-content attack vectors so the escape/scheme gates are exercised. */
const FIXTURE: DigestEmailPayload = {
  digestId: 7,
  userId: "00000000-0000-0000-0000-000000000007" as UserId,
  recipient: { email: "Owner@Example.com", name: "Owner" },
  createdAt: new Date("2026-06-11T00:00:00Z"),
  items: [
    {
      rank: 1,
      reason: `Ships "real-time" pipelines & more — <b>bold claim</b>.`,
      title: `<script>alert("xss")</script> Staff Engineer`,
      companySlug: "evil-corp",
      applyUrl: "javascript:alert('xss')",
      locations: [],
      remote: true,
    },
    {
      rank: 2,
      reason: "Plain safe item.",
      title: "Backend Engineer",
      companySlug: "acme",
      applyUrl: "https://example.com/jobs/2",
      locations: ["Berlin"],
      remote: false,
    },
  ],
};

/** A fake DeliveryStepTools that records step/sleep ids and runs fns inline. */
function fakeStep(): { runs: string[]; sleeps: string[]; tools: DeliveryStepTools } {
  const runs: string[] = [];
  const sleeps: string[] = [];
  return {
    runs,
    sleeps,
    tools: {
      run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
        runs.push(id);
        return fn();
      },
      sleep: async (id: string): Promise<void> => {
        sleeps.push(id);
      },
    },
  };
}

/**
 * A chainable-thenable Db stub: every property access / call returns the chain; `await` pops the
 * next queued value. The repo functions under test run their REAL code (drizzle just builds query
 * ASTs) — only the final await is faked. One queued entry per awaited db call, in call order. The
 * real SQL round-trip is exercised by `pnpm --filter @opusfinder/db test:digest-payload`, not here.
 */
function stubDb(queued: unknown[]): Db {
  const target = (): void => undefined;
  const chain: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
          if (queued.length === 0) reject(new Error("stubDb: no queued result left"));
          else resolve(queued.shift());
        };
      }
      return () => chain;
    },
    apply() {
      return chain;
    },
  });
  return chain as Db;
}

/** Rows shaped like getDigestEmailPayload's joined select projection (2 items). */
function joinedPayloadRows(): unknown[] {
  const head = {
    userId: FIXTURE.userId,
    createdAt: FIXTURE.createdAt,
    email: FIXTURE.recipient.email,
    name: FIXTURE.recipient.name,
  };
  return FIXTURE.items.map((it) => ({ ...head, ...it }));
}

await runScript("test-digest-email", async () => {
  // 1. Render determinism + escaping: byte-identical across renders; hostile input inert.
  const a = renderDigestEmail(FIXTURE);
  const b = renderDigestEmail(FIXTURE);
  assert(
    a.subject === b.subject && a.html === b.html && a.text === b.text,
    "render not deterministic",
  );
  assert(!a.html.includes("<script"), "raw <script survived escaping");
  assert(a.html.includes("&lt;script&gt;"), "escaped script tag missing from html");
  assert(!/href="javascript:/i.test(a.html), "javascript: URL became an href");
  assert(a.html.includes('href="https://example.com/jobs/2"'), "safe https href missing");
  assert(!a.subject.includes("<"), "subject carries markup");
  console.log("1. render determinism + escaping OK");

  // 2. The ONE idempotency-key definition.
  assert(emailIdempotencyKey(123) === "digest/123", `key shape: ${emailIdempotencyKey(123)}`);
  console.log("2. idempotency-key shape OK");

  // 3. Event mapping + terminal set (the §7 policy table).
  assert(mapDeliveryEvent("delivered").status === "delivered", "delivered→delivered");
  assert(mapDeliveryEvent("opened").status === "delivered", "opened→delivered");
  assert(mapDeliveryEvent("clicked").status === "delivered", "clicked→delivered");
  const bounced = mapDeliveryEvent("bounced");
  assert(bounced.status === "bounced", "bounced→bounced");
  assert(bounced.suppress?.bounce === "hard", "bounced must hard-suppress");
  const complained = mapDeliveryEvent("complained");
  assert(complained.status === "delivered", "complained records delivered");
  assert(complained.suppress !== undefined, "complained must suppress");
  assert(complained.suppress.bounce === undefined, "complained must NOT touch bounce status");
  assert(mapDeliveryEvent("failed").status === "failed", "failed→failed");
  for (const e of ["queued", "scheduled", "sent", "delivery_delayed", "suppressed", "garbage"]) {
    assert(mapDeliveryEvent(e).status === "sent", `${e} must stay sent`);
    assert(mapDeliveryEvent(e).suppress === undefined, `${e} must not suppress`);
  }
  const terminal = ["delivered", "opened", "clicked", "bounced", "complained", "failed"];
  for (const e of terminal) assert(isTerminalEvent(e), `${e} must be terminal`);
  for (const e of ["queued", "scheduled", "sent", "delivery_delayed", "suppressed", "received"]) {
    assert(!isTerminalEvent(e), `${e} must NOT be terminal`);
  }
  console.log("3. event mapping + terminal set OK");

  // 4. Allowlist fail-closed (no RESEND_API_KEY anywhere in this test — the skip/refuse paths must
  //    never construct the client).
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY_FULL;
  delete process.env.EMAIL_FROM;
  delete process.env.EMAIL_ALLOWLIST;
  const noConfig = await expectReject(sendDigestEmail(FIXTURE), "send with EMAIL_ALLOWLIST unset");
  assert(noConfig.message.includes("EMAIL_ALLOWLIST"), "missing-allowlist error names the var");
  process.env.EMAIL_ALLOWLIST = "  someone-else@example.com , ,";
  const skipped = await sendDigestEmail(FIXTURE);
  assert("skipped" in skipped && skipped.skipped === "allowlist", "unlisted recipient must skip");
  console.log("4. allowlist fail-closed + recorded skip OK");

  // 5. Failure terminalization: send throws → record-send-failure runs, original error rethrown.
  {
    const { runs, sleeps, tools } = fakeStep();
    const db = stubDb([joinedPayloadRows(), []]); // payload read, then the failure write
    const err = await expectReject(
      deliverDigestEmail(
        tools,
        db,
        {
          send: async () => {
            throw new Error("boom");
          },
          lastEvent: async () => "delivered",
        },
        7,
      ),
      "deliverDigestEmail with throwing send",
    );
    assert(err.message === "boom", `original error must rethrow, got: ${err.message}`);
    assert(
      JSON.stringify(runs) === '["send-email","record-send-failure"]',
      `steps: ${runs.join(",")}`,
    );
    assert(sleeps.length === 0, "failure path must not sleep");
  }
  {
    // Null payload (digest row vanished) takes the same terminalize path.
    const { runs, tools } = fakeStep();
    const db = stubDb([[], []]); // empty join read, then the failure write
    const err = await expectReject(
      deliverDigestEmail(
        tools,
        db,
        {
          send: async () => ({ emailId: "re_x" }),
          lastEvent: async () => "delivered",
        },
        7,
      ),
      "deliverDigestEmail with missing payload",
    );
    assert(err.message.includes("payload missing"), `unexpected error: ${err.message}`);
    assert(
      JSON.stringify(runs) === '["send-email","record-send-failure"]',
      `steps: ${runs.join(",")}`,
    );
  }
  console.log("5. failure terminalization OK");

  // 6. Allowlist-skip path: one step, zero sleeps, no state writes.
  {
    const { runs, sleeps, tools } = fakeStep();
    const db = stubDb([joinedPayloadRows()]); // ONLY the payload read
    const result = await deliverDigestEmail(
      tools,
      db,
      {
        send: async () => ({ skipped: "allowlist" }),
        lastEvent: async () => "delivered",
      },
      7,
    );
    assert(result === "skipped-allowlist", `skip result: ${String(result)}`);
    assert(JSON.stringify(runs) === '["send-email"]', `steps: ${runs.join(",")}`);
    assert(sleeps.length === 0, "skip path must not sleep");
  }
  console.log("6. skip path OK");

  // 7. Happy path: send → first poll terminal (delivered) → record; one sleep, no second poll.
  {
    const { runs, sleeps, tools } = fakeStep();
    const db = stubDb([
      joinedPayloadRows(), // payload read
      [{ userId: FIXTURE.userId }], // recordDigestSent: digests update RETURNING
      [], // recordDigestSent: user_preferences update
      [{ userId: FIXTURE.userId }], // recordDigestDeliveryOutcome: digests update RETURNING
    ]);
    const result = await deliverDigestEmail(
      tools,
      db,
      {
        send: async () => ({ emailId: "re_x" }),
        lastEvent: async () => "delivered",
      },
      7,
    );
    assert(result === "delivered", `happy result: ${String(result)}`);
    assert(
      JSON.stringify(runs) === '["send-email","delivery-poll-0","record-delivery"]',
      `steps: ${runs.join(",")}`,
    );
    assert(JSON.stringify(sleeps) === '["delivery-wait-0"]', `sleeps: ${sleeps.join(",")}`);
  }
  console.log("7. happy path OK");

  // 8. Slow-poll + bounce: first poll in-flight → second sleep/poll → bounced → suppression write.
  {
    const { runs, sleeps, tools } = fakeStep();
    const events = ["sent", "bounced"];
    const db = stubDb([
      joinedPayloadRows(), // payload read
      [{ userId: FIXTURE.userId }], // recordDigestSent: digests RETURNING
      [], // recordDigestSent: user_preferences update
      [{ userId: FIXTURE.userId }], // recordDigestDeliveryOutcome: digests RETURNING
      [], // recordDigestDeliveryOutcome: suppression update
    ]);
    const result = await deliverDigestEmail(
      tools,
      db,
      {
        send: async () => ({ emailId: "re_x" }),
        lastEvent: async () => events.shift() ?? "bounced",
      },
      7,
    );
    assert(result === "bounced", `slow-poll result: ${String(result)}`);
    assert(
      JSON.stringify(runs) ===
        '["send-email","delivery-poll-0","delivery-poll-1","record-delivery"]',
      `steps: ${runs.join(",")}`,
    );
    assert(
      JSON.stringify(sleeps) === '["delivery-wait-0","delivery-wait-1"]',
      `sleeps: ${sleeps.join(",")}`,
    );
  }
  console.log("8. slow-poll + bounce suppression OK");

  console.log("test-digest-email OK");
});
