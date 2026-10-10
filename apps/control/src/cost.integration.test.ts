import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BILLING_ADDRESS, ORIGIN, startControl, type ControlHarness } from "@test/control/harness";

import { DAILY_MAIL_CAP, DAILY_MODEL_READS } from "./limits";

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
  it("records a forwarded invoice the model reads, and the cost view totals it", async () => {
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
        status: "recorded",
        updated_by: "mailbox",
      },
    ]);
    const c = await costJson();
    expect(c.months).toEqual([
      { month: thisMonth(), cents: 842, vendors: [{ vendor: "Neon", cents: 842, n: 1 }] },
    ]);
    expect(c.statements).toHaveLength(1);
    expect(c.billingAddress).toBe(BILLING_ADDRESS);
    expect(c.targetUsdPerMonth).toBe(50);
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

  it("marks the receipt for an already-recorded invoice as a duplicate (same number, or same amount within 3 days)", async () => {
    await h.email(email({ answer: bill({ reference: "INV-7" }) }));
    await h.email(email({ subject: "Your receipt", answer: bill({ reference: "INV-7" }) }));
    await h.email(
      email({
        from: "billing@voyageai.com",
        answer: bill({ vendor: "Voyage AI", reference: "", total: "20.00" }),
      }),
    );
    await h.email(
      email({
        from: "billing@voyageai.com",
        answer: bill({ vendor: "voyage ai", reference: "", total: "20.00" }),
      }),
    );
    const r = await rows();
    expect(r.map((x) => x.status)).toEqual(["recorded", "duplicate", "recorded", "duplicate"]);
    expect(r[1]?.note).toBe(`Same charge as #${r[0]?.id}.`);
    const c = await costJson();
    expect(c.months[0].cents).toBe(842 + 2000);
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
    expect((await rows()).map((r) => r.status)).toEqual(["recorded", "recorded"]);
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

describe("statements by hand", () => {
  const add = (as: "owner" | "agent" | "runtime", json: Record<string, unknown>) =>
    h.request("/v1/statements", { as, json });

  it("lets the owner and agents add history; a repeat is a duplicate", async () => {
    const first = await add("agent", {
      vendor: "Neon",
      amount: "8.42",
      chargedOn: "2026-10-01",
      kind: "usage",
      periodStart: "2026-09-01",
    });
    expect(first.status).toBe(201);
    const again = (await (
      await add("owner", { vendor: "Neon", amount: 8.42, chargedOn: "2026-10-02" })
    ).json()) as Json;
    expect(again.duplicateOf).toBe(((await first.json()) as Json).statement.id);
    expect(await rows()).toMatchObject([
      { source: "manual", month: "2026-09", status: "recorded", updated_by: "agent:observer" },
      { source: "manual", status: "duplicate", updated_by: `owner:owner@example.com` },
    ]);
    expect(
      (await add("runtime", { vendor: "x", amount: "1", chargedOn: "2026-10-01" })).status,
    ).toBe(403);
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

  it("is not readable by runtimes", async () => {
    expect((await h.request("/v1/cost", { as: "runtime" })).status).toBe(403);
  });

  it("refuses a malformed month", async () => {
    expect((await h.request("/v1/cost?month=2026-13x", { as: "agent" })).status).toBe(400);
  });
});

describe("the Cost page", () => {
  it("shows the month's total, the queue and the statements; forms for the owner only", async () => {
    await h.email(email({ answer: bill() }));
    await h.email(email({ answer: bill({ total: "" }), subject: "Invoice with a PDF" }));
    const owner = await (await h.request("/cost", { as: "owner" })).text();
    expect(owner).toContain("$8.42");
    expect(owner).toContain("Needs your review (1)");
    expect(owner).toContain("Invoice with a PDF");
    expect(owner).toContain(`<code>${BILLING_ADDRESS}</code>`);
    expect(owner).toContain('action="/ui/statements"');
    const agent = await (await h.request("/cost", { as: "agent" })).text();
    expect(agent).toContain("$8.42");
    expect(agent).not.toContain('method="post"');
    const home = await (await h.request("/", { as: "owner" })).text();
    expect(home).toContain("$8.42 this month");
    expect(home).toContain("1 to review");
  });

  it("lets the owner count a reviewed statement with the amount they read, or exclude one", async () => {
    await h.email(email({ answer: bill({ total: "" }) }));
    await h.email(email({ answer: bill({ reference: "INV-2" }) }));
    const [unread, recorded] = await rows();
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
    const exclude = await h.request(`/ui/statements/${recorded?.id}`, {
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
    expect((await rows())[0]?.status).toBe("recorded");
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
