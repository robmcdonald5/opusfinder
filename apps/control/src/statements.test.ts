import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";

import {
  GMAIL_FORWARDING_SENDER,
  INVOICE_MODEL,
  cents,
  filingMonth,
  htmlToText,
  readEmail,
  validDay,
  type InvoiceAi,
} from "./statements";

// Reading one forwarded email into a statement: the Gmail forwarding code, the model's answer (validated
// field by field), the PDF fallback, and everything that must land in review instead of the totals.

const RECEIVED = "2026-10-10T12:00:00.000Z";

function raw(opts: {
  from?: string;
  subject?: string;
  body?: string;
  html?: string;
  pdf?: string;
}) {
  const from = opts.from ?? "Neon <billing@neon.tech>";
  const head = `From: ${from}\r\nTo: billing@opusfinder.ai\r\nSubject: ${opts.subject ?? "Your invoice"}\r\nDate: Thu, 01 Oct 2026 09:00:00 +0000\r\nMessage-ID: <m1@neon.tech>\r\nMIME-Version: 1.0\r\n`;
  if (opts.pdf) {
    return `${head}Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\n${
      opts.body ?? ""
    }\r\n--b\r\nContent-Type: application/pdf; name="invoice.pdf"\r\nContent-Disposition: attachment; filename="invoice.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${btoa(
      opts.pdf,
    )}\r\n--b--\r\n`;
  }
  if (opts.html) return `${head}Content-Type: text/html\r\n\r\n${opts.html}\r\n`;
  return `${head}Content-Type: text/plain\r\n\r\n${opts.body ?? ""}\r\n`;
}

const parse = (r: string) => PostalMime.parse(r);

const bill = (over: Record<string, unknown> = {}) => ({
  is_bill: true,
  vendor: "Neon",
  kind: "usage",
  total: "8.42",
  currency: "USD",
  charged_on: "2026-10-01",
  period_start: "2026-09-01",
  reference: "INV-0003",
  ...over,
});

/** A fake AI: answers in order; records what it was asked. */
function fakeAi(
  answers: unknown[],
  pdfText = "Total due $12.00",
): InvoiceAi & { asked: string[]; pdfs: number } {
  const ai = {
    asked: [] as string[],
    pdfs: 0,
    async run(model: string, inputs: Record<string, unknown>) {
      expect(model).toBe(INVOICE_MODEL);
      const messages = inputs.messages as { content: string }[];
      ai.asked.push(messages.map((m) => m.content).join("\n"));
      return { response: answers.shift() };
    },
    async toMarkdown() {
      ai.pdfs++;
      return [{ format: "markdown", data: pdfText }];
    },
  };
  return ai;
}

describe("readEmail", () => {
  it("records a bill the model reads, every field validated", async () => {
    const ai = fakeAi([bill()]);
    const r = await readEmail(await parse(raw({ body: "Amount due: $8.42" })), ai, RECEIVED);
    expect(r).toEqual({
      status: "recorded",
      vendor: "Neon",
      kind: "usage",
      amountCents: 842,
      currency: "USD",
      chargedOn: "2026-10-01",
      periodStart: "2026-09-01",
      reference: "INV-0003",
      note: null,
    });
    expect(ai.asked[0]).toContain("Subject: Your invoice");
    expect(ai.asked[0]).toContain("Amount due: $8.42");
  });

  it("reads an HTML-only email as text", async () => {
    const ai = fakeAi([bill()]);
    await readEmail(
      await parse(raw({ html: "<style>p{}</style><p>Total</p><td>&#36;8.42</td>" })),
      ai,
      RECEIVED,
    );
    expect(ai.asked[0]).toContain("Total");
    expect(ai.asked[0]).toContain("$8.42");
    expect(ai.asked[0]).not.toContain("<td>");
  });

  it("shows Gmail's forwarding confirmation code instead of asking the model", async () => {
    const ai = fakeAi([]);
    const r = await readEmail(
      await parse(
        raw({
          from: `Gmail Team <${GMAIL_FORWARDING_SENDER}>`,
          subject:
            "(#123456789) Gmail Forwarding Confirmation - Receive Mail from owner@example.com",
          body: "Confirmation code: 123456789",
        }),
      ),
      ai,
      RECEIVED,
    );
    expect(r).toMatchObject({
      status: "ignored",
      note: "Gmail forwarding confirmation code: 123456789",
    });
    expect(ai.asked).toHaveLength(0);
  });

  it("keeps Gmail's verification link (from the HTML too), but only on Google's own mail hosts", async () => {
    const link = "https://mail-settings.google.com/mail/vf-%5BABC%5D-xyz";
    const r = await readEmail(
      await parse(
        raw({
          from: `Gmail Team <${GMAIL_FORWARDING_SENDER}>`,
          subject: "Gmail Forwarding Confirmation",
          html: `<p>Click <a href="${link}">here</a> to confirm.</p>`,
        }),
      ),
      fakeAi([]),
      RECEIVED,
    );
    expect(r.note).toBe(`Gmail forwarding confirmation link: ${link}`);
    const spoof = await readEmail(
      await parse(
        raw({
          from: `Gmail Team <${GMAIL_FORWARDING_SENDER}>`,
          body: "Confirm at https://mail-settings.google.com.evil.example/x or https://evil.example/mail.google.com/",
        }),
      ),
      fakeAi([]),
      RECEIVED,
    );
    expect(spoof.note).toBe("Gmail forwarding confirmation (no code or link found).");
  });

  it("sends a bill to review when there is no model to read it", async () => {
    const r = await readEmail(
      await parse(raw({ body: "$8.42" })),
      undefined,
      RECEIVED,
      "Over the cap.",
    );
    expect(r).toMatchObject({ status: "review", vendor: "neon.tech", note: "Over the cap." });
  });

  it("ignores what the model says isn't a bill", async () => {
    const r = await readEmail(
      await parse(raw({ body: "Our new pricing page" })),
      fakeAi([bill({ is_bill: false })]),
      RECEIVED,
    );
    expect(r).toMatchObject({ status: "ignored", note: "Not a bill." });
  });

  it.each([
    ["no answer", undefined],
    ["a non-object", "sure! here you go"],
    ["an array", [1, 2]],
  ])("sends %s from the model to review", async (_label, answer) => {
    const r = await readEmail(await parse(raw({ body: "$8.42" })), fakeAi([answer]), RECEIVED);
    expect(r).toMatchObject({ status: "review", note: "The model gave no usable answer." });
  });

  it("accepts an answer the model returned as a JSON string", async () => {
    const r = await readEmail(
      await parse(raw({ body: "$8.42" })),
      fakeAi([JSON.stringify(bill())]),
      RECEIVED,
    );
    expect(r.status).toBe("recorded");
  });

  it("never guesses a currency: not USD, or unstated without a $ amount, goes to review", async () => {
    const eur = await readEmail(
      await parse(raw({ body: "Total 8,42 EUR" })),
      fakeAi([bill({ currency: "EUR" })]),
      RECEIVED,
    );
    expect(eur).toMatchObject({ status: "review", currency: "EUR" });
    const unstated = await readEmail(
      await parse(raw({ body: "Total 8.42" })),
      fakeAi([bill({ currency: "" })]),
      RECEIVED,
    );
    expect(unstated).toMatchObject({ status: "review", currency: null });
    const dollar = await readEmail(
      await parse(raw({ body: "Total $8.42" })),
      fakeAi([bill({ currency: "" })]),
      RECEIVED,
    );
    expect(dollar).toMatchObject({ status: "recorded", currency: "USD" });
  });

  it("falls back to the email's date for an implausible charge date, and drops a bad period", async () => {
    const r = await readEmail(
      await parse(raw({ body: "$8.42" })),
      fakeAi([bill({ charged_on: "2031-01-01", period_start: "last month" })]),
      RECEIVED,
    );
    expect(r).toMatchObject({ chargedOn: "2026-10-01", periodStart: null });
  });

  it("reads the attached PDF when the email body has no total", async () => {
    const ai = fakeAi([bill({ total: "" }), bill({ total: "12.00" })], "Total due $12.00");
    const r = await readEmail(
      await parse(raw({ body: "Your invoice is attached.", pdf: "%PDF-1.4 fake" })),
      ai,
      RECEIVED,
    );
    expect(ai.pdfs).toBe(1);
    expect(ai.asked[1]).toContain("Attached PDF:\nTotal due $12.00");
    expect(r).toMatchObject({ status: "recorded", amountCents: 1200 });
  });

  it("sends it to review when neither the body nor the PDF has a total", async () => {
    const r = await readEmail(
      await parse(raw({ body: "Attached.", pdf: "%PDF" })),
      fakeAi([bill({ total: "" }), bill({ total: "" })]),
      RECEIVED,
    );
    expect(r).toMatchObject({ status: "review", note: "No total found in the email." });
  });

  it("propagates a transport error for the mailbox to record", async () => {
    const ai: InvoiceAi = {
      run: () => Promise.reject(new Error("AI down")),
      toMarkdown: () => Promise.reject(new Error("AI down")),
    };
    await expect(readEmail(await parse(raw({ body: "$8.42" })), ai, RECEIVED)).rejects.toThrow(
      "AI down",
    );
  });
});

describe("cents", () => {
  it.each<[unknown, number | null]>([
    ["8.42", 842],
    ["$1,234.5", 123450],
    ["USD 5", 500],
    [5.33, 533],
    ["0", 0],
    ["-3", null],
    ["8.425", null],
    ["12345678", null],
    ["about ten", null],
    ["", null],
    [null, null],
  ])("%j → %j", (raw, expected) => {
    expect(cents(raw)).toBe(expected);
  });
});

describe("filingMonth / htmlToText", () => {
  it("files under the service period when stated, else the charge date; credits when bought", () => {
    expect(filingMonth("usage", "2026-09-01", "2026-10-01")).toBe("2026-09");
    expect(filingMonth("usage", null, "2026-10-01")).toBe("2026-10");
    expect(filingMonth("credits", "2026-09-01", "2026-10-08")).toBe("2026-10");
    expect(filingMonth("usage", null, null)).toBeNull();
  });

  it.each<[string, string | null]>([
    ["2026-10-10", "2026-10-10"],
    ["2026-10-11", "2026-10-11"], // a day ahead of UTC: a vendor's timezone
    ["2026-10-12", null],
    ["2026-02-30", null], // not a real date (Date.parse would roll it into March)
    ["2026-00-45", null],
    ["2019-12-31", null],
    ["10/10/2026", null],
  ])("validDay(%j) → %j", (raw, expected) => {
    expect(validDay(raw, "2026-10-10T20:00:00.000Z")).toBe(expected);
  });

  it("keeps the text and drops markup, styles and scripts", () => {
    expect(htmlToText("<script>x()</script><p>Total&nbsp;&amp;</p><br><b>$5</b>")).toBe(
      "Total &\n$5",
    );
  });
});
