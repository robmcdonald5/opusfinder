/**
 * Stub-seam smoke for the email-delivery tail (src/delivery.ts + @opusfinder/email) — NO creds, NO
 * network, NO real DB. Locks render determinism + escaping, the idempotency-key shape, the full
 * last_event→status mapping (incl. bounce→hard-suppress, complaint→suppress-without-bounce), the
 * DB-native send-permit (digest_approved_at) skip behavior, and the failure / skip / happy / slow-poll
 * step sequences (via a fake `step` + a chainable-thenable stub Db).
 *
 *   pnpm --filter @opusfinder/inngest test:digest-email
 */
import type { DigestEmailPayload } from "@opusfinder/db/repos";
import { emailIdempotencyKey, renderDigestEmail } from "@opusfinder/email";
import { runScript } from "@opusfinder/shared/script";
import type { UserId } from "@opusfinder/shared";

import { recordingStep, stubDb } from "./_stub.ts";
import { deliverDigestEmail, isTerminalEvent, mapDeliveryEvent } from "../src/delivery.ts";

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
  approvedAt: new Date("2026-06-10T00:00:00Z"),
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

/** Rows shaped like getDigestEmailPayload's joined projection (2 items); `states` drives each item's
 *  `lifecycle_state` so the stub's real `.filter` exercises the app-side render-time lifecycle filter. */
function joinedPayloadRows(
  states: string[] = FIXTURE.items.map(() => "active"),
  approved = true,
): unknown[] {
  const head = {
    userId: FIXTURE.userId,
    createdAt: FIXTURE.createdAt,
    email: FIXTURE.recipient.email,
    name: FIXTURE.recipient.name,
    // The send-permit re-read (digest_approved_at): non-null = approved. `approved=false` drives the
    // un-approved no-send branch in deliverDigestEmail.
    approvedAt: approved ? FIXTURE.approvedAt : null,
  };
  return FIXTURE.items.map((it, i) => ({ ...head, ...it, lifecycleState: states[i] ?? "active" }));
}

await runScript("test-digest-email", async () => {
  // 1. Render determinism + escaping: byte-identical across renders; hostile input inert.
  const firstRender = renderDigestEmail(FIXTURE);
  const secondRender = renderDigestEmail(FIXTURE);
  assert(
    firstRender.subject === secondRender.subject &&
      firstRender.html === secondRender.html &&
      firstRender.text === secondRender.text,
    "render not deterministic",
  );
  assert(!firstRender.html.includes("<script"), "raw <script survived escaping");
  assert(firstRender.html.includes("&lt;script&gt;"), "escaped script tag missing from html");
  assert(!/href="javascript:/i.test(firstRender.html), "javascript: URL became an href");
  assert(firstRender.html.includes('href="https://example.com/jobs/2"'), "safe https href missing");
  assert(!firstRender.subject.includes("<"), "subject carries markup");
  console.log("1. render determinism + escaping OK");

  // 2. The ONE idempotency-key definition.
  assert(emailIdempotencyKey(123) === "digest/123", `key shape: ${emailIdempotencyKey(123)}`);
  console.log("2. idempotency-key shape OK");

  // 3. Event mapping + terminal set.
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
  for (const event of ["queued", "scheduled", "sent", "delivery_delayed", "suppressed", "garbage"]) {
    assert(mapDeliveryEvent(event).status === "sent", `${event} must stay sent`);
    assert(mapDeliveryEvent(event).suppress === undefined, `${event} must not suppress`);
  }
  const terminal = ["delivered", "opened", "clicked", "bounced", "complained", "failed"];
  for (const event of terminal) assert(isTerminalEvent(event), `${event} must be terminal`);
  for (const event of ["queued", "scheduled", "sent", "delivery_delayed", "suppressed", "received"]) {
    assert(!isTerminalEvent(event), `${event} must NOT be terminal`);
  }
  console.log("3. event mapping + terminal set OK");

  // 4. DB-native send permit: an UN-APPROVED recipient (digest_approved_at NULL, re-read at the send
  //    boundary) is a clean no-send — NO email.send, NO poll, ONE step. No creds/network.
  {
    const { runs, sleeps, tools } = recordingStep();
    const db = stubDb([joinedPayloadRows(undefined, false)]); // ONLY the payload read; approvedAt = null
    let sendCalled = false;
    const result = await deliverDigestEmail(
      tools,
      db,
      {
        send: async () => {
          sendCalled = true;
          return { emailId: "re_x" };
        },
        lastEvent: async () => "delivered",
      },
      7,
    );
    assert(result === "skipped-unapproved", `unapproved result: ${String(result)}`);
    assert(!sendCalled, "send must not be called for an un-approved recipient");
    assert(JSON.stringify(runs) === '["send-email"]', `steps: ${runs.join(",")}`);
    assert(sleeps.length === 0, "permit-skip path must not sleep");
  }
  console.log("4. send permit blocks un-approved recipient OK");

  // 5. Failure terminalization: send throws → record-send-failure runs, original error rethrown.
  {
    const { runs, sleeps, tools } = recordingStep();
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
    const { runs, tools } = recordingStep();
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

  // 6. Happy path: send → first poll terminal (delivered) → record; one sleep, no second poll.
  {
    const { runs, sleeps, tools } = recordingStep();
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
  console.log("6. happy path OK");

  // 7. Slow-poll + bounce: first poll in-flight → second sleep/poll → bounced → suppression write.
  {
    const { runs, sleeps, tools } = recordingStep();
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
  console.log("7. slow-poll + bounce suppression OK");

  // 8. All items lifecycle-closed between persist and send: the render filters every item, so
  //    deliverDigestEmail must clean no-send ("skipped-empty") — NO email.send, NO poll, ONE step.
  {
    const { runs, sleeps, tools } = recordingStep();
    const db = stubDb([joinedPayloadRows(["closed", "closed"])]); // ONLY the payload read
    let sendCalled = false;
    const result = await deliverDigestEmail(
      tools,
      db,
      {
        send: async () => {
          sendCalled = true;
          return { emailId: "re_x" };
        },
        lastEvent: async () => "delivered",
      },
      7,
    );
    assert(result === "skipped-empty", `all-closed result: ${String(result)}`);
    assert(!sendCalled, "send must not be called when every item is closed");
    assert(JSON.stringify(runs) === '["send-email"]', `steps: ${runs.join(",")}`);
    assert(sleeps.length === 0, "empty-payload path must not sleep");
  }
  console.log("8. G1b all-closed → clean no-send OK");

  // 9. Mixed active+closed: the closed item is filtered out at render, the active one still sends.
  {
    const { runs, sleeps, tools } = recordingStep();
    const db = stubDb([
      joinedPayloadRows(["active", "closed"]), // payload read (rank 1 active, rank 2 closed)
      [{ userId: FIXTURE.userId }], // recordDigestSent: digests update RETURNING
      [], // recordDigestSent: user_preferences update
      [{ userId: FIXTURE.userId }], // recordDigestDeliveryOutcome: digests update RETURNING
    ]);
    let sentItemCount = -1;
    const result = await deliverDigestEmail(
      tools,
      db,
      {
        send: async (payload) => {
          sentItemCount = payload.items.length;
          return { emailId: "re_x" };
        },
        lastEvent: async () => "delivered",
      },
      7,
    );
    assert(result === "delivered", `mixed result: ${String(result)}`);
    assert(sentItemCount === 1, `closed item not filtered from render: sent ${sentItemCount} item(s)`);
    assert(
      JSON.stringify(runs) === '["send-email","delivery-poll-0","record-delivery"]',
      `steps: ${runs.join(",")}`,
    );
    assert(JSON.stringify(sleeps) === '["delivery-wait-0"]', `sleeps: ${sleeps.join(",")}`);
  }
  console.log("9. G1b mixed active+closed → only active rendered OK");

  console.log("test-digest-email OK");
});
