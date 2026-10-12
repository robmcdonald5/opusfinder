import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BILLING_ADDRESS, ORIGIN, startControl, type ControlHarness } from "@test/control/harness";

import {
  DAILY_AGENT_STATEMENTS,
  DAILY_CONFIRMATION_CAP,
  DAILY_MAIL_CAP,
  DAILY_MODEL_READS,
} from "./limits";

// The billing mailbox and the Cost page, end to end: a raw email through Miniflare's email trigger into the
// real email() handler (the model is the harness's FakeAi), the statement rows it writes, the cost read
// model, and the owner's review forms.

let h: ControlHarness;
beforeAll(async () => {
  h = await startControl();
}, 60_000);
afterAll(async () => {
  await h?.dispose();
});
beforeEach(async () => {
  await h.reset();
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-side JSON probing

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);

let seq = 0;
/** A vendor email; `answer` scripts the fake model (see FAKE_AI_SCRIPT in the harness). */
function email(opts: {
  answer?: Record<string, unknown> | "fail";
  from?: string;
  subject?: string;
  body?: string;
  messageId?: string;
}): string {
  const from = opts.from ?? "billing@neon.tech";
  const marker =
    opts.answer === "fail"
      ? "FAKE_AI_FAIL"
      : opts.answer
        ? `FAKE_AI ${JSON.stringify(opts.answer)}`
        : "";
  return [
    `From: Vendor <${from}>`,
    `To: ${BILLING_ADDRESS}`,
    `Subject: ${opts.subject ?? "Your invoice"}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${opts.messageId ?? `<msg-${++seq}-${Date.now()}@vendor.test>`}`,
    "Content-Type: text/plain",
    "",
    opts.body ?? "Amount due: $8.42",
    marker,
    "",
  ].join("\r\n");
}

const bill = (over: Record<string, unknown> = {}) => ({
  is_bill: true,
  vendor: "Neon",
  kind: "usage",
  total: "8.42",
  currency: "USD",
  charged_on: today(),
  period_start: "",
  reference: "INV-1",
  ...over,
});

async function rows(): Promise<Json[]> {
  return (await h.db.prepare("SELECT * FROM statement ORDER BY id").all()).results as Json[];
}

async function costJson(as: "owner" | "agent" = "agent", month?: string): Promise<Json> {
  const res = await h.request(`/v1/cost${month ? `?month=${month}` : ""}`, { as });
  expect(res.status).toBe(200);
  return (await res.json()) as Json;
}

describe("the billing mailbox", () => {
  it("files a forwarded invoice for the owner to count, pre-filled with what the model read", async () => {
    // From the Worker's side a forged owner envelope looks exactly like this, so nothing counts by itself.
    const res = await h.email(email({ answer: bill() }));
    expect(res.status).toBe(200);
    expect(await rows()).toMatchObject([
      {
        source: "email",
        sender: "billing@neon.tech",
        subject: "Your invoice",
        vendor: "Neon",
        kind: "usage",
        amount_cents: 842,
        currency: "USD",
        month: thisMonth(),
        reference: "INV-1",
        status: "review",
        note: null,
        updated_by: "mailbox",
      },
    ]);
    const c = await costJson();
    expect(c.months).toEqual([]);
    expect(c.review).toHaveLength(1);
    expect(c.billingAddress).toBe(BILLING_ADDRESS);
    expect(c.targetUsdPerMonth).toBe(50);
    expect(await (await h.request("/cost", { as: "owner" })).text()).toContain(
      'name="amount" type="number" inputmode="decimal" min="0" step="0.01" required value="8.42"',
    );
  });

  it("files a charge under the service period it covers", async () => {
    await h.email(email({ answer: bill({ period_start: "2026-09-01", charged_on: today() }) }));
    expect((await rows())[0]).toMatchObject({ month: "2026-09", period_start: "2026-09-01" });
  });

  it("keeps one row for one email, however often it arrives", async () => {
    const raw = email({ answer: bill(), messageId: "<same@vendor.test>" });
    await h.email(raw);
    await h.email(raw);
    expect(await rows()).toHaveLength(1);
  });

  it("marks a second email for a charge, counted or still waiting, as its duplicate (same number however written, or same amount within 3 days)", async () => {
    await h.email(email({ answer: bill({ reference: "INV-7" }) }));
    await h.email(email({ subject: "Your receipt", answer: bill({ reference: "#inv 7" }) }));
    await add("owner", { vendor: "Voyage AI", amount: "20.00", chargedOn: today() });
    await h.email(
      email({
        from: "billing@voyageai.com",
        answer: bill({ vendor: "voyage ai", reference: "", total: "20.00" }),
      }),
    );
    const r = await rows();
    expect(r.map((x) => x.status)).toEqual(["review", "duplicate", "recorded", "duplicate"]);
    expect(r[1]?.note).toBe(`Same charge as #${r[0]?.id}.`);
    const c = await costJson();
    expect(c.months[0].cents).toBe(2000);
  });

  it("accepts only what the owner forwarded: their address as envelope sender, Gmail's +caf_ form included", async () => {
    // Gmail auto-forwards keep the forwarding account as the envelope sender, tagged +caf_=…; Gmail also
    // ignores dots in its addresses.
    await h.email(email({ answer: bill({ reference: "A" }) }), {
      from: "owner+caf_=billing=control.test@example.com",
    });
    await h.email(email({ answer: bill({ reference: "B" }) }), {
      from: "Second-Owner@Example.com",
    });
    await h.email(email({ answer: bill({ reference: "C", total: "4999.00" }) }), {
      from: "attacker@evil.example",
    });
    expect((await rows()).map((r) => r.reference)).toEqual(["A", "B"]);
  });

  it("refuses a display-name spoof of Gmail's forwarding sender", async () => {
    await h.email(
      email({ from: "x@evil.example", body: "Confirmation code: 1", answer: bill() }).replace(
        "From: Vendor <x@evil.example>",
        'From: "forwarding-noreply@google.com" <x@evil.example>',
      ),
      { from: "x@evil.example" },
    );
    expect(await rows()).toHaveLength(0);
  });

  it("refuses a message with two From addresses (the gate and the reader could see different ones)", async () => {
    const twoFroms = email({ from: "x@evil.example", answer: bill({ total: "950.00" }) }).replace(
      "From: Vendor <x@evil.example>",
      "From: forwarding-noreply@google.com\r\nFrom: invoices@neon.tech",
    );
    await h.email(twoFroms, { from: "x@evil.example" });
    expect(await rows()).toHaveLength(0);
  });

  it("files mail let in only as Gmail's confirmation as that and nothing else: never read, never counted", async () => {
    await h.email(
      email({ from: "forwarding-noreply@google.com", answer: bill({ total: "950.00" }) }),
      { from: "bounce@google.example" },
    );
    expect(await rows()).toMatchObject([
      { status: "ignored", sender: "forwarding-noreply@google.com", amount_cents: null },
    ]);
  });

  it("caps confirmations apart from the owner's forwards, so junk ones can't use up the quota", async () => {
    const now = new Date().toISOString();
    await h.db.batch(
      Array.from({ length: DAILY_CONFIRMATION_CAP }, (_, i) =>
        h.db
          .prepare(
            "INSERT INTO statement (received_at, source, message_id, sender, status, updated_at, updated_by) VALUES (?, 'email', ?, 'forwarding-noreply@google.com', 'ignored', ?, 'test')",
          )
          .bind(now, `<conf-${i}@test>`, now),
      ),
    );
    await h.email(email({ from: "forwarding-noreply@google.com", body: "Confirmation code: 9" }), {
      from: "forwarding-noreply@google.com",
    });
    expect(await rows()).toHaveLength(DAILY_CONFIRMATION_CAP);
    await h.email(email({ answer: bill() })); // the owner's forward still gets in
    expect((await rows()).at(-1)).toMatchObject({ status: "review", amount_cents: 842 });
  });

  it("records the receiving server's authentication verdicts, domains only (shadow evidence)", async () => {
    const withAuth = email({ answer: bill() }).replace(
      "Content-Type: text/plain",
      "Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=owner+caf_=billing=control.test@example.com; dkim=pass header.d=neon.tech\r\nContent-Type: text/plain",
    );
    await h.email(withAuth);
    expect((await rows())[0]?.auth).toBe(
      "[mx.cloudflare.net] spf=pass(example.com) dkim=pass(neon.tech)",
    );
  });

  it("stops accepting mail after the day's cap", async () => {
    const now = new Date().toISOString();
    await h.db.batch(
      Array.from({ length: DAILY_MAIL_CAP }, (_, i) =>
        h.db
          .prepare(
            "INSERT INTO statement (received_at, source, message_id, status, updated_at, updated_by) VALUES (?, 'email', ?, 'ignored', ?, 'test')",
          )
          .bind(now, `<mail-cap-${i}@test>`, now),
      ),
    );
    await h.email(email({ answer: bill() }));
    expect(await rows()).toHaveLength(DAILY_MAIL_CAP);
  });

  it("never merges two numbered invoices with different numbers, however alike", async () => {
    const renewal = bill({ vendor: "Cloudflare", kind: "domain", total: "10.46" });
    await h.email(email({ answer: { ...renewal, reference: "IN-1" } }));
    await h.email(email({ answer: { ...renewal, reference: "IN-2" } }));
    expect((await rows()).map((r) => r.status)).toEqual(["review", "review"]);
  });

  it("files prepaid credits when bought, whatever period the model read", async () => {
    await h.email(email({ answer: bill({ kind: "credits", period_start: "2026-01-01" }) }));
    expect((await rows())[0]?.month).toBe(thisMonth());
  });

  it("refuses mail for any other address", async () => {
    // Miniflare hands the message to the Worker over JS RPC, so setReject() lands after it has answered
    // (200); production calls it synchronously. What matters here is that nothing is recorded.
    await h.email(email({ answer: bill() }), { to: "someone@control.test" });
    expect(await rows()).toHaveLength(0);
  });

  it("records what it can't read for the owner: no total, a failed model call, a non-bill", async () => {
    await h.email(email({ answer: bill({ total: "" }) }));
    await h.email(email({ answer: "fail" }));
    await h.email(email({ body: "Our new pricing page" }));
    expect(await rows()).toMatchObject([
      { status: "review", note: "No total found in the email." },
      { status: "review", note: "The model call failed: Error: AI unavailable (fake)" },
      {
        status: "review",
        note: "The model didn't find a bill in it: count it with the amount, or don't.",
      },
    ]);
  });

  it("stops asking the model after the day's cap; the rest wait for the owner", async () => {
    const now = new Date().toISOString();
    await h.db.batch(
      Array.from({ length: DAILY_MODEL_READS }, (_, i) =>
        h.db
          .prepare(
            "INSERT INTO statement (received_at, source, message_id, status, updated_at, updated_by) VALUES (?, 'email', ?, 'ignored', ?, 'test')",
          )
          .bind(now, `<cap-${i}@test>`, now),
      ),
    );
    await h.email(email({ answer: bill() }));
    const last = (await rows()).at(-1);
    expect(last).toMatchObject({ status: "review" });
    expect(last?.note).toContain(`limit of ${DAILY_MODEL_READS}`);
  });

  it("shows Gmail's forwarding code to the owner only", async () => {
    await h.email(
      email({
        from: "forwarding-noreply@google.com",
        subject: "(#987654321) Gmail Forwarding Confirmation - Receive Mail from owner@example.com",
        body: "Confirmation code: 987654321",
      }),
      { from: "forwarding-noreply@google.com" },
    );
    const owner = await costJson("owner");
    expect(owner.notCounted[0].note).toBe("Gmail forwarding confirmation code: 987654321");
    // However the sender is spelled, agents still don't see it.
    await h.db
      .prepare("UPDATE statement SET sender = 'Gmail Team <Forwarding-NoReply@Google.com>'")
      .run();
    const agent = await costJson("agent");
    expect(JSON.stringify(agent)).not.toContain("987654321");
    const page = await (await h.request("/cost", { as: "agent" })).text();
    expect(page).not.toContain("987654321");
    expect(await (await h.request("/cost", { as: "owner" })).text()).toContain("987654321");
  });
});

describe("Gmail's confirmation link", () => {
  it("is a clickable link for the owner only", async () => {
    const link = "https://mail-settings.google.com/mail/vf-abc123";
    await h.email(
      email({
        from: "forwarding-noreply@google.com",
        subject: "Gmail Forwarding Confirmation",
        body: `To confirm, click ${link}`,
      }),
      { from: "forwarding-noreply@google.com" },
    );
    const owner = await (await h.request("/cost", { as: "owner" })).text();
    expect(owner).toContain(`<a href="${link}" rel="noreferrer noopener" target="_blank">`);
    const agent = await (await h.request("/cost", { as: "agent" })).text();
    expect(agent).not.toContain(link);
  });
});

const add = (as: "owner" | "agent" | "runtime", json: Record<string, unknown>) =>
  h.request("/v1/statements", { as, json });

describe("statements by hand", () => {
  it("counts the owner's entries; an agent's wait for the owner's review; a repeat is a duplicate", async () => {
    const first = await add("owner", {
      vendor: "Neon",
      amount: "8.42",
      chargedOn: "2026-10-01",
      kind: "usage",
      periodStart: "2026-09-01",
    });
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as Json).statement.id;
    // The same charge again, spelled differently: still a duplicate.
    const again = (await (
      await add("agent", { vendor: "Neon, LLC", amount: 8.42, chargedOn: "2026-10-02" })
    ).json()) as Json;
    expect(again.duplicateOf).toBe(firstId);
    await add("agent", { vendor: "Voyage AI", amount: "120", chargedOn: "2026-10-09" });
    expect(await rows()).toMatchObject([
      {
        source: "manual",
        month: "2026-09",
        status: "recorded",
        updated_by: "owner:owner@example.com",
      },
      { source: "manual", status: "duplicate", updated_by: "agent:observer" },
      { source: "manual", vendor: "Voyage AI", status: "review", updated_by: "agent:observer" },
    ]);
    expect((await rows())[2]?.note).toContain("Added by agent:observer");
    expect(
      (await add("runtime", { vendor: "x", amount: "1", chargedOn: "2026-10-01" })).status,
    ).toBe(403);
  });

  it("files an agent's repeat of an entry still waiting as its duplicate", async () => {
    const entry = { vendor: "Voyage AI", amount: "120", chargedOn: "2026-10-09" };
    const first = (await (await add("agent", entry)).json()) as Json;
    const again = (await (await add("agent", entry)).json()) as Json;
    expect(again.duplicateOf).toBe(first.statement.id);
    expect((await rows()).map((r) => r.status)).toEqual(["review", "duplicate"]);
  });

  it("still names the agent who entered a charge once the owner has counted or excluded it", async () => {
    const enter = async (vendor: string, note: string) => {
      const res = await add("agent", { vendor, amount: "4.00", chargedOn: "2026-10-01", note });
      return ((await res.json()) as Json).statement.id;
    };
    const counted = await enter("Neon", "from the console");
    const excluded = await enter("Voyage AI", "from the dashboard");
    await h.request(`/ui/statements/${counted}`, {
      as: "owner",
      form: {
        action: "count",
        vendor: "Neon",
        amount: "4.00",
        chargedOn: "2026-10-01",
        kind: "other",
      },
    });
    await h.request(`/ui/statements/${excluded}`, { as: "owner", form: { action: "exclude" } });
    const page = await (await h.request("/cost?month=2026-10", { as: "owner" })).text();
    expect(page.match(/entered by <span title="agent:observer">/g)).toHaveLength(2);
    expect(page).toContain("from the dashboard");
    expect(page).not.toContain("Added by agent:observer");
  });

  it.each([
    [{ amount: "1", chargedOn: "2026-10-01" }, "invalid_vendor"],
    [{ vendor: "Neon", amount: "-1", chargedOn: "2026-10-01" }, "invalid_amount"],
    [{ vendor: "Neon", amount: "1", chargedOn: "2999-01-01" }, "invalid_date"],
    [{ vendor: "Neon", amount: "1", chargedOn: "2026-00-45" }, "invalid_date"],
    [
      { vendor: "Neon", amount: "1", chargedOn: "2026-10-01", periodStart: "2026-13-01" },
      "invalid_date",
    ],
    [
      { vendor: "Neon", amount: "1", chargedOn: "2026-10-01", periodStart: "2099-01-01" },
      "invalid_date",
    ],
    [{ vendor: "Neon", amount: "1", chargedOn: "2026-10-01", kind: "lunch" }, "invalid_kind"],
  ])("refuses %j (%s)", async (json, code) => {
    const res = await add("owner", json);
    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).error.code).toBe(code);
  });

  it("caps one agent's hand entries per UTC day; the owner's still go in", async () => {
    const entry = (i: number) => ({
      vendor: "Voyage AI",
      amount: String(i + 1),
      chargedOn: today(),
    });
    for (let i = 0; i < DAILY_AGENT_STATEMENTS; i++)
      expect((await add("agent", entry(i))).status).toBe(201);
    const over = await add("agent", entry(DAILY_AGENT_STATEMENTS));
    expect(over.status).toBe(429);
    expect(((await over.json()) as Json).error.code).toBe("too_many_statements");
    expect((await add("owner", entry(DAILY_AGENT_STATEMENTS))).status).toBe(201);
  });

  it("is not readable by runtimes", async () => {
    expect((await h.request("/v1/cost", { as: "runtime" })).status).toBe(403);
  });

  it("refuses a malformed month", async () => {
    expect((await h.request("/v1/cost?month=2026-13x", { as: "agent" })).status).toBe(400);
  });
});

describe("the Cost page", () => {
  it("shows the month's total, the queue and the statements; forms for the owner only", async () => {
    await add("owner", { vendor: "Neon", amount: "8.42", chargedOn: today(), kind: "usage" });
    await h.email(email({ answer: bill({ total: "" }), subject: "Invoice with a PDF" }));
    const owner = await (await h.request("/cost", { as: "owner" })).text();
    expect(owner).toContain("$8.42");
    expect(owner).toContain("Needs your review (1)");
    expect(owner).toContain("Invoice with a PDF");
    expect(owner).toContain('action="/ui/statements"');
    const agent = await (await h.request("/cost", { as: "agent" })).text();
    expect(agent).toContain("$8.42");
    expect(agent).not.toContain('method="post"');
    const home = await (await h.request("/", { as: "owner" })).text();
    expect(home).toContain("Spend this month");
    expect(home).toContain(">$8.42<");
    expect(home).toContain("1 charge to review");
  });

  it("flags a charge waiting for review that matches one already counted", async () => {
    await h.email(email({ answer: bill({ reference: "INV-9" }) }));
    const counted = (await (
      await add("owner", { vendor: "Neon", amount: "8.42", chargedOn: today(), reference: "INV-9" })
    ).json()) as Json;
    expect(counted.duplicateOf).toBeNull();
    expect((await costJson()).review[0].sameAs).toBe(counted.statement.id);
    expect(await (await h.request("/cost", { as: "owner" })).text()).toContain(
      `Same charge as #${counted.statement.id}, already counted.`,
    );
  });

  it("warns on the overview when last month went over the target", async () => {
    const last = new Date();
    last.setUTCDate(1);
    last.setUTCMonth(last.getUTCMonth() - 1);
    // A usage invoice arrives after the month it covers, so it never lands in this month's total.
    await add("owner", {
      vendor: "Neon",
      amount: "60.00",
      chargedOn: today(),
      kind: "usage",
      periodStart: last.toISOString().slice(0, 10),
    });
    const name = last.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    expect(await (await h.request("/", { as: "owner" })).text()).toContain(
      `${name} was over the monthly target`,
    );
  });

  it("lets the owner count a reviewed statement with the amount they read, or exclude one", async () => {
    await h.email(email({ answer: bill({ total: "" }) }));
    await h.email(email({ answer: bill({ reference: "INV-2" }) }));
    const [unread, read] = await rows();
    const count = await h.request(`/ui/statements/${unread?.id}`, {
      as: "owner",
      form: {
        action: "count",
        vendor: "Neon",
        amount: "3.10",
        chargedOn: today(),
        kind: "usage",
        note: "",
      },
    });
    expect(count.status).toBe(303);
    expect(count.headers.get("location")).toBe("/cost?done=statement_counted");
    const exclude = await h.request(`/ui/statements/${read?.id}`, {
      as: "owner",
      form: { action: "exclude" },
    });
    expect(exclude.headers.get("location")).toBe("/cost?done=statement_excluded");
    expect(await rows()).toMatchObject([
      { status: "recorded", amount_cents: 310, note: null, updated_by: "owner:owner@example.com" },
      { status: "excluded" },
    ]);
  });

  it("lets the owner correct the month a charge is filed under, and accept a vendor's 'tomorrow'", async () => {
    await h.email(email({ answer: bill({ period_start: "2025-12-01", total: "" }) }));
    const id = (await rows())[0]?.id;
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const res = await h.request(`/ui/statements/${id}`, {
      as: "owner",
      form: {
        action: "count",
        vendor: "Neon",
        amount: "2.00",
        chargedOn: tomorrow,
        periodStart: "",
        kind: "usage",
        note: "",
      },
    });
    expect(res.status).toBe(303);
    expect((await rows())[0]).toMatchObject({
      status: "recorded",
      period_start: null,
      month: tomorrow.slice(0, 7),
    });
  });

  it("files a charge billed in advance under the month it covers once the owner enters that period", async () => {
    // Two months ahead: on a month's last day, the next month's first is "tomorrow", which the model may give.
    const next = new Date();
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + 2);
    const periodStart = next.toISOString().slice(0, 10);
    // The model's reading of a future period isn't trusted: the charge waits under its charge date.
    await h.email(email({ answer: bill({ kind: "subscription", period_start: periodStart }) }));
    const [row] = await rows();
    expect(row).toMatchObject({ period_start: null, month: thisMonth() });
    const res = await h.request(`/ui/statements/${row?.id}`, {
      as: "owner",
      form: {
        action: "count",
        vendor: "Neon",
        amount: "8.42",
        chargedOn: today(),
        periodStart,
        kind: "subscription",
        note: "",
      },
    });
    expect(res.status).toBe(303);
    expect((await rows())[0]).toMatchObject({ status: "recorded", month: periodStart.slice(0, 7) });
  });

  it("counts every statement waiting for review, not just the ones it lists", async () => {
    const now = new Date().toISOString();
    await h.db.batch(
      Array.from({ length: 55 }, (_, i) =>
        h.db
          .prepare(
            "INSERT INTO statement (received_at, source, message_id, status, updated_at, updated_by) VALUES (?, 'manual', ?, 'review', ?, 'test')",
          )
          .bind(now, `<review-${i}@test>`, now),
      ),
    );
    const c = await costJson();
    expect(c.review).toHaveLength(50);
    expect(c.reviewCount).toBe(55);
    const page = await (await h.request("/cost", { as: "owner" })).text();
    expect(page).toContain("Needs your review (55)");
    expect(await (await h.request("/", { as: "owner" })).text()).toContain("55 to review");
  });

  it("counts every charge not counted, and lists the ones filed in the period asked for", async () => {
    const now = new Date().toISOString();
    await h.db.batch(
      Array.from({ length: 22 }, (_, i) =>
        h.db
          .prepare(
            "INSERT INTO statement (received_at, source, message_id, month, status, updated_at, updated_by) VALUES (?, 'manual', ?, ?, 'excluded', ?, 'test')",
          )
          .bind(now, `<excluded-${i}@test>`, i === 0 ? "2025-01" : null, now),
      ),
    );
    const c = await costJson();
    expect(c.notCounted).toHaveLength(20);
    expect(c.notCountedCount).toBe(21);
    expect(await (await h.request("/cost", { as: "owner" })).text()).toContain("Not counted (21)");
    // The oldest is out of this month's list, but still there to count from its own month; the rows with
    // no month are listed under the month they arrived.
    const older = await costJson("owner", "2025-01");
    expect(older.notCounted.map((r: Json) => r.message_id)).toEqual(["<excluded-0@test>"]);
  });

  it("offers Count it on every uncounted row except Gmail's confirmation", async () => {
    await h.email(email({ answer: bill({ reference: "D-1" }) }));
    await h.email(email({ answer: bill({ reference: "D-1" }), subject: "Your receipt" })); // duplicate
    await h.email(
      email({ from: "forwarding-noreply@google.com", body: "Confirmation code: 111222333" }),
      { from: "forwarding-noreply@google.com" },
    );
    // A row an earlier build filed as "ignored" (the 2026-10-10 Neon forward) must be rescuable.
    await h.db
      .prepare(
        "INSERT INTO statement (received_at, source, message_id, sender, subject, status, note, updated_at, updated_by) VALUES (?, 'email', '<old@x>', 'owner@example.com', 'Fwd: Neon', 'ignored', 'Not a bill.', ?, 'mailbox')",
      )
      .bind(new Date().toISOString(), new Date().toISOString())
      .run();
    const r = await rows();
    const page = await (await h.request("/cost", { as: "owner" })).text();
    const duplicate = r.find((x) => x.status === "duplicate");
    const old = r.find((x) => x.message_id === "<old@x>");
    const confirmation = r.find((x) => x.sender === "forwarding-noreply@google.com");
    expect(page).toContain(`action="/ui/statements/${duplicate?.id}"`);
    expect(page).toContain(`action="/ui/statements/${old?.id}"`);
    expect(page).not.toContain(`action="/ui/statements/${confirmation?.id}"`);
  });

  it("keeps a counted statement's note when it's edited, and never shows or pre-fills a non-USD or unknown-currency amount as USD", async () => {
    await add("owner", {
      vendor: "Neon",
      amount: "8.42",
      chargedOn: "2026-10-01",
      note: "Q3 back-fill",
    });
    await h.email(email({ answer: bill({ currency: "EUR", total: "8.42", reference: "EU-1" }) }));
    // No currency stated and no "$" in the email: unknown, never taken for USD.
    await h.email(
      email({
        body: "Amount due: 19.99",
        answer: bill({ currency: "", total: "19.99", reference: "X-1" }),
      }),
    );
    const page = await (await h.request("/cost", { as: "owner" })).text();
    expect(page).toContain('value="Q3 back-fill"');
    const read = (await rows()).filter((r) => r.source === "email");
    expect(read.map((r) => r.currency)).toEqual(["EUR", null]);
    for (const r of read) {
      const form = page.slice(page.indexOf(`action="/ui/statements/${r.id}"`));
      expect(form.slice(0, form.indexOf("</form>"))).toContain(
        'name="amount" type="number" inputmode="decimal" min="0" step="0.01" required value=""',
      );
    }
    expect(page).toContain("<strong>8.42</strong> EUR");
    expect(page).not.toContain("$19.99");
  });

  it("refuses an impossible month", async () => {
    expect((await h.request("/v1/cost?month=2026-13", { as: "agent" })).status).toBe(400);
    expect((await h.request("/cost?month=2026-00", { as: "owner" })).status).toBe(400);
  });

  it("shows one line per vendor in a month, however the name was spelled", async () => {
    await add("owner", {
      vendor: "Neon, LLC",
      amount: "8.42",
      chargedOn: "2026-10-01",
      kind: "usage",
    });
    expect(
      (
        await add("owner", {
          vendor: "Neon",
          amount: "1.00",
          chargedOn: "2026-10-05",
          kind: "usage",
        })
      ).status,
    ).toBe(201);
    const c = await costJson("owner", "2026-10");
    expect(c.months.find((m: Json) => m.month === "2026-10").vendors).toEqual([
      { vendor: "Neon, LLC", cents: 942, n: 2 },
    ]);
  });

  it("refuses to count Gmail's confirmation, even when asked directly", async () => {
    await h.email(email({ from: "forwarding-noreply@google.com", body: "Confirmation code: 4" }), {
      from: "forwarding-noreply@google.com",
    });
    const id = (await rows())[0]?.id;
    const res = await h.request(`/ui/statements/${id}`, {
      as: "owner",
      form: { action: "count", vendor: "Google", amount: "1", chargedOn: today(), kind: "other" },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not_a_charge");
    expect((await rows())[0]?.status).toBe("ignored");
    // Still refused after the owner excludes it (the row stays a confirmation whatever its status).
    await h.request(`/ui/statements/${id}`, { as: "owner", form: { action: "exclude" } });
    const again = await h.request(`/ui/statements/${id}`, {
      as: "owner",
      form: { action: "count", vendor: "Google", amount: "1", chargedOn: today(), kind: "other" },
    });
    expect(again.status).toBe(400);
  });

  it("adds a statement from the page", async () => {
    const res = await h.request("/ui/statements", {
      as: "owner",
      form: {
        vendor: "Vercel",
        amount: "20",
        chargedOn: "2026-07-13",
        kind: "subscription",
        periodStart: "",
        reference: "",
        note: "Pro plan",
      },
    });
    expect(res.headers.get("location")).toBe("/cost?done=statement_added");
    expect((await rows())[0]).toMatchObject({
      vendor: "Vercel",
      amount_cents: 2000,
      month: "2026-07",
      note: "Pro plan",
    });
    expect(await (await h.request("/cost?month=2026-07", { as: "owner" })).text()).toContain(
      "Pro plan",
    );
    const again = await h.request("/ui/statements", {
      as: "owner",
      form: { vendor: "Vercel", amount: "20", chargedOn: "2026-07-14", kind: "subscription" },
    });
    expect(again.headers.get("location")).toBe("/cost?done=statement_duplicate");
  });

  it("shows a period of whole months picked on the calendar, and keeps ?month= working", async () => {
    for (const [vendor, chargedOn] of [
      ["Neon", "2026-08-01"],
      ["Vercel", "2026-09-13"],
      ["Voyage AI", "2026-10-02"],
    ])
      await h.request("/v1/statements", {
        as: "owner",
        json: { vendor, amount: "5.00", chargedOn, kind: "subscription" },
      });
    const vendors = (c: Json) => c.statements.map((s: Json) => s.vendor);
    const range = (await (
      await h.request("/v1/cost?from=2026-08-15&to=2026-09-02", { as: "agent" })
    ).json()) as Json;
    expect(range).toMatchObject({ month: "2026-08", toMonth: "2026-09" });
    expect(vendors(range)).toEqual(["Vercel", "Neon"]);
    expect(vendors(await costJson("agent", "2026-10"))).toEqual(["Voyage AI"]);

    const page = await (
      await h.request("/cost?from=2026-08-15&to=2026-09-02", { as: "owner" })
    ).text();
    expect(page).toContain("Aug – Sep 2026 · $10.00");
    expect(page).toContain('<input type="date" name="from" value="2026-08-01">');
    expect(page).toContain('<input type="date" name="to" value="2026-09-30">');
    expect(page).toContain('href="/cost?from=2026-09-01&amp;to=2026-09-30#month"');

    // One end left open runs like the Log tabs: back to the first filed month, or on to this one.
    const upTo = (await (
      await h.request("/v1/cost?to=2026-09-30", { as: "agent" })
    ).json()) as Json;
    expect(upTo).toMatchObject({ month: "2026-08", toMonth: "2026-09" });
    expect(vendors(upTo)).toEqual(["Vercel", "Neon"]);
    const onFrom = (await (
      await h.request("/v1/cost?from=2026-09-01", { as: "agent" })
    ).json()) as Json;
    expect(onFrom.month).toBe("2026-09");
    expect(vendors(onFrom)).toEqual(["Voyage AI", "Vercel"]);
    expect((await h.request("/cost?from=2026-09-30&to=2026-09-01", { as: "owner" })).status).toBe(
      400,
    );
  });

  it("refuses the forms to agents and to cross-site posts", async () => {
    await h.email(email({ answer: bill() }));
    const id = (await rows())[0]?.id;
    expect(
      (await h.request(`/ui/statements/${id}`, { as: "agent", form: { action: "exclude" } }))
        .status,
    ).toBe(403);
    const csrf = await h.request(`/ui/statements/${id}`, {
      as: "owner",
      headers: { origin: "https://evil.example" },
      form: { action: "exclude" },
    });
    expect(csrf.status).toBe(403);
    expect((await rows())[0]?.status).toBe("review");
  });

  it("answers a bad statement id or month with a readable error page", async () => {
    expect(
      (
        await h.request("/ui/statements/999", {
          as: "owner",
          headers: { origin: ORIGIN },
          form: { action: "exclude" },
        })
      ).status,
    ).toBe(404);
    expect((await h.request("/cost?month=nope", { as: "owner" })).status).toBe(400);
  });
});
