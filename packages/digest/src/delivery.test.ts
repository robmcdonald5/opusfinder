/**
 * Unit suite for the email-delivery tail of `digest-user` (src/delivery.ts). NO creds, NO network, NO real
 * DB — a fake `step` (recordingStep) + a chainable-thenable stub Db drive it. Locks the full
 * last_event→outcome mapping, the terminal-event set, and the failure / skip / happy / slow-poll STEP
 * SEQUENCES (the load-bearing invariant). Render determinism/escaping + the idempotency-key shape are NOT
 * re-homed here — @opusfinder/email owns them (render.test.ts + transport.integration.test.ts).
 */
import { describe, expect, it, vi } from "vitest";

import type { DigestEmailPayload } from "@opusfinder/db/repos";
import { sendDigestEmail } from "@opusfinder/email";
import type { UserId } from "@opusfinder/shared";
import { recordingStep, stubDb } from "@test/digest/stubs";

import { deliverDigestEmail, isTerminalEvent, mapDeliveryEvent } from "./delivery";

/** Hostile fixture — kept identical to the proven smoke input so getDigestEmailPayload's real projection +
 *  lifecycle `.filter` sees exactly what it saw before. Content is irrelevant to delivery orchestration
 *  (the send seam is stubbed); only items.length / approvedAt / lifecycleState drive the branches here. */
const FIXTURE: DigestEmailPayload = {
  digestId: 7,
  userId: "00000000-0000-0000-0000-000000000007" as UserId,
  recipient: { email: "Owner@Example.com", name: "Owner" },
  createdAt: new Date("2026-06-11T00:00:00Z"),
  approvedAt: new Date("2026-06-10T00:00:00Z"),
  eligible: true,
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

/** The delivery-setting read (getDigestDelivery) the send step makes once the other gates pass. */
const EMAIL_ACCOUNT = [{ delivery: "email" }];
const LOGS_ACCOUNT = [{ delivery: "logs" }];

/** Rows shaped like getDigestEmailPayload's joined projection (2 items); `states` drives each item's
 *  `lifecycleState` so the stub's REAL `.filter` exercises the app-side render-time lifecycle filter. */
function joinedPayloadRows(
  states: string[] = FIXTURE.items.map(() => "active"),
  approved = true,
  eligible = true,
): unknown[] {
  const head = {
    userId: FIXTURE.userId,
    createdAt: FIXTURE.createdAt,
    email: FIXTURE.recipient.email,
    name: FIXTURE.recipient.name,
    // The send-permit re-read (digest_approved_at): non-null = approved. `approved=false` drives the
    // un-approved no-send branch in deliverDigestEmail.
    approvedAt: approved ? FIXTURE.approvedAt : null,
    eligible,
  };
  return FIXTURE.items.map((it, i) => ({ ...head, ...it, lifecycleState: states[i] ?? "active" }));
}

describe("mapDeliveryEvent", () => {
  it("maps delivered/opened/clicked to delivered (no suppression)", () => {
    for (const event of ["delivered", "opened", "clicked"]) {
      expect(mapDeliveryEvent(event)).toEqual({ status: "delivered" });
    }
  });

  it("maps bounced to bounced + hard suppression", () => {
    expect(mapDeliveryEvent("bounced")).toEqual({ status: "bounced", suppress: { bounce: "hard" } });
  });

  it("maps complained to delivered + suppress WITHOUT touching bounce status", () => {
    const outcome = mapDeliveryEvent("complained");
    expect(outcome.status).toBe("delivered");
    expect(outcome.suppress).toEqual({});
    expect(outcome.suppress?.bounce).toBeUndefined();
  });

  it("maps failed to failed", () => {
    expect(mapDeliveryEvent("failed")).toEqual({ status: "failed" });
  });

  it("maps suppressed (Resend refused the address) to failed + suppress WITHOUT touching bounce status", () => {
    expect(mapDeliveryEvent("suppressed")).toEqual({ status: "failed", suppress: {} });
  });

  it("keeps every non-terminal / unknown event as sent with NO suppression", () => {
    for (const event of ["queued", "scheduled", "sent", "delivery_delayed", "garbage"]) {
      expect(mapDeliveryEvent(event)).toEqual({ status: "sent" });
    }
  });
});

describe("isTerminalEvent", () => {
  it("is true for the terminal set", () => {
    for (const event of [
      "delivered",
      "opened",
      "clicked",
      "bounced",
      "complained",
      "failed",
      "suppressed",
    ]) {
      expect(isTerminalEvent(event)).toBe(true);
    }
  });

  it("is false for in-flight / unknown events", () => {
    for (const event of ["queued", "scheduled", "sent", "delivery_delayed", "received"]) {
      expect(isTerminalEvent(event)).toBe(false);
    }
  });
});

describe("deliverDigestEmail", () => {
  it.each([
    ["the account is set to logs", LOGS_ACCOUNT, undefined],
    ["the account's setting can't be found", [], undefined],
    ["the stage is in logs-only mode", EMAIL_ACCOUNT, async () => true],
  ])("stores without sending when %s — one step, no poll", async (_why, account, logsOnly) => {
    const { runs, sleeps, tools } = recordingStep();
    const db = stubDb([joinedPayloadRows(), account]);
    const send = vi.fn();

    const result = await deliverDigestEmail(
      tools,
      db,
      { send, lastEvent: async () => "delivered" },
      7,
      logsOnly,
    );

    expect(result).toBe("skipped-logs-only");
    expect(send).not.toHaveBeenCalled();
    expect(runs).toEqual(["send-email"]);
    expect(sleeps).toEqual([]);
  });

  it("skips an un-approved recipient without sending — one step, no poll", async () => {
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

    expect(result).toBe("skipped-unapproved");
    expect(sendCalled).toBe(false);
    expect(runs).toEqual(["send-email"]);
    expect(sleeps).toEqual([]);
  });

  it("skips a recipient who opted out, was suppressed or lost verification mid-run — no send, no poll", async () => {
    const { runs, sleeps, tools } = recordingStep();
    const db = stubDb([joinedPayloadRows(undefined, true, false)]);
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

    expect(result).toBe("skipped-ineligible");
    expect(sendCalled).toBe(false);
    expect(runs).toEqual(["send-email"]);
    expect(sleeps).toEqual([]);
  });

  it("terminalizes a thrown send: record-send-failure runs, original error rethrown", async () => {
    const { runs, sleeps, tools } = recordingStep();
    const db = stubDb([joinedPayloadRows(), EMAIL_ACCOUNT, []]); // the two reads, then the failure write

    await expect(
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
    ).rejects.toThrow("boom");

    expect(runs).toEqual(["send-email", "record-send-failure"]);
    expect(sleeps).toEqual([]);
  });

  it("terminalizes a missing payload (digest row vanished) via the same path", async () => {
    const { runs, tools } = recordingStep();
    const db = stubDb([[], []]); // empty join read (null payload), then the failure write

    await expect(
      deliverDigestEmail(
        tools,
        db,
        { send: async () => ({ emailId: "re_x" }), lastEvent: async () => "delivered" },
        7,
      ),
    ).rejects.toThrow(/payload missing/);

    expect(runs).toEqual(["send-email", "record-send-failure"]);
  });

  it("happy path: send → first poll terminal → record; one sleep, no second poll", async () => {
    const { runs, sleeps, tools } = recordingStep();
    const db = stubDb([
      joinedPayloadRows(), // payload read
      EMAIL_ACCOUNT,
      [{ userId: FIXTURE.userId }], // recordDigestSent: digests update RETURNING
      [], // recordDigestSent: user_preferences update
      [{ userId: FIXTURE.userId }], // recordDigestDeliveryOutcome: digests update RETURNING
    ]);

    const result = await deliverDigestEmail(
      tools,
      db,
      { send: async () => ({ emailId: "re_x" }), lastEvent: async () => "delivered" },
      7,
    );

    expect(result).toBe("delivered");
    expect(runs).toEqual(["send-email", "record-sent", "delivery-poll-0", "record-delivery"]);
    expect(sleeps).toEqual(["delivery-wait-0"]);
  });

  it("a retried send step can't email twice: the retry sends the same bytes under the same idempotency key", async () => {
    // Resend, as far as this matters: a repeated Idempotency-Key with the same body returns the first
    // email's id and sends nothing; with a different body it answers 409.
    const accepted = new Map<string, string>();
    const requests: { key: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit & { headers: Headers }) => {
      const key = new Headers(init.headers).get("idempotency-key");
      const body = String(init.body);
      requests.push({ key, body });
      const first = accepted.get(key ?? "");
      if (first !== undefined && first !== body) return Response.json({}, { status: 409 });
      if (key) accepted.set(key, body);
      return Response.json({ id: "re_only_one" });
    });
    const email = { apiKey: "re_send_test", apiKeyFull: "re_full_test", from: "d@send.test" };
    const { tools } = recordingStep();
    // The engine runs the send step's body twice: the first attempt's result was lost after Resend had
    // accepted the email (a timeout, a crash before the result was stored).
    const atLeastOnce = {
      ...tools,
      run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
        if (id === "send-email") await fn();
        return tools.run(id, fn);
      },
    };
    const db = stubDb([
      joinedPayloadRows(), // first attempt: the payload read and the delivery setting
      EMAIL_ACCOUNT,
      joinedPayloadRows(), // the retry reads both again
      EMAIL_ACCOUNT,
      [{ userId: FIXTURE.userId }], // recordDigestSent: digests update RETURNING
      [], // recordDigestSent: user_preferences update
      [{ userId: FIXTURE.userId }], // recordDigestDeliveryOutcome: digests update RETURNING
    ]);

    const result = await deliverDigestEmail(
      atLeastOnce,
      db,
      { send: (payload) => sendDigestEmail(payload, email), lastEvent: async () => "delivered" },
      7,
    );
    vi.unstubAllGlobals();

    expect(result).toBe("delivered");
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.key)).toEqual(["digest/7", "digest/7"]);
    expect(requests[1]!.body).toBe(requests[0]!.body);
    expect(accepted.size).toBe(1); // one email
  });

  it("a failed record-sent after an accepted send never records a send failure", async () => {
    const { runs, sleeps, tools } = recordingStep();
    const db = stubDb([joinedPayloadRows(), EMAIL_ACCOUNT]); // the reads only — recordDigestSent's write then rejects
    let sends = 0;

    await expect(
      deliverDigestEmail(
        tools,
        db,
        {
          send: async () => {
            sends++;
            return { emailId: "re_x" };
          },
          lastEvent: async () => "delivered",
        },
        7,
      ),
    ).rejects.toThrow(/no queued result/);

    expect(sends).toBe(1);
    expect(runs).toEqual(["send-email", "record-sent"]);
    expect(sleeps).toEqual([]);
  });

  it("slow poll + bounce: first poll in-flight → second sleep/poll → bounced → suppression write", async () => {
    const { runs, sleeps, tools } = recordingStep();
    const events = ["sent", "bounced"];
    const db = stubDb([
      joinedPayloadRows(), // payload read
      EMAIL_ACCOUNT,
      [{ userId: FIXTURE.userId }], // recordDigestSent: digests RETURNING
      [], // recordDigestSent: user_preferences update
      [{ userId: FIXTURE.userId }], // recordDigestDeliveryOutcome: digests RETURNING
      [], // recordDigestDeliveryOutcome: suppression update (bounce → +1 await)
    ]);

    const result = await deliverDigestEmail(
      tools,
      db,
      { send: async () => ({ emailId: "re_x" }), lastEvent: async () => events.shift() ?? "bounced" },
      7,
    );

    expect(result).toBe("bounced");
    expect(runs).toEqual([
      "send-email",
      "record-sent",
      "delivery-poll-0",
      "delivery-poll-1",
      "record-delivery",
    ]);
    expect(sleeps).toEqual(["delivery-wait-0", "delivery-wait-1"]);
  });

  it("cleanly no-sends when EVERY item was lifecycle-closed between persist and send", async () => {
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

    expect(result).toBe("skipped-empty");
    expect(sendCalled).toBe(false);
    expect(runs).toEqual(["send-email"]);
    expect(sleeps).toEqual([]);
  });

  it("mixed active+closed: the closed item is filtered from render, the active one still sends", async () => {
    const { runs, sleeps, tools } = recordingStep();
    const db = stubDb([
      joinedPayloadRows(["active", "closed"]), // payload read (rank 1 active, rank 2 closed)
      EMAIL_ACCOUNT,
      [{ userId: FIXTURE.userId }], // recordDigestSent: digests RETURNING
      [], // recordDigestSent: user_preferences update
      [{ userId: FIXTURE.userId }], // recordDigestDeliveryOutcome: digests RETURNING
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

    expect(result).toBe("delivered");
    expect(sentItemCount).toBe(1); // closed item filtered out of the render
    expect(runs).toEqual(["send-email", "record-sent", "delivery-poll-0", "record-delivery"]);
    expect(sleeps).toEqual(["delivery-wait-0"]);
  });
});
