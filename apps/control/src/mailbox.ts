import PostalMime, { type Email } from "postal-mime";

import { parseOwnerEmails } from "./auth-config";
import type { Env } from "./env";
import { DAILY_MAIL_CAP, DAILY_MODEL_READS, MAX_EMAIL_BYTES } from "./limits";
import { errorSummary } from "./service";
import {
  EMPTY_READING,
  filingMonth,
  isGmailConfirmation,
  readEmail,
  type Reading,
} from "./statements";
import { emailsSince, findSameCharge, insertStatement, statementExists } from "./store";

/**
 * The billing mailbox: Email Routing delivers each email sent to the billing address (the owner's Gmail
 * filter forwards vendor invoices there) to this Worker's email() handler, which records one statement row.
 *
 * Who may write here: only mail whose ENVELOPE sender is one of the owner's addresses (a Gmail forward keeps
 * the forwarding account as the envelope sender; Cloudflare's docs call `message.from` the trustworthy
 * one — header addresses can be spoofed), plus Gmail's forwarding confirmation, which the owner needs to see.
 * Everything else is refused at the SMTP stage: no row, no model read. Without the gate, anyone who learned
 * the address could put an invented charge into the totals.
 *
 * Once accepted, a vendor's invoice is never lost for a reason of ours: anything unreadable is still
 * recorded, for the owner to review on the Cost page. A database error is NOT swallowed: email() throws, and
 * Email Routing reports a temporary failure, so the sender retries.
 */

/**
 * The comparable form of an address: lowercase, the "+tag" dropped (Gmail's forwards arrive as
 * `name+caf_=…@gmail.com`), and dots dropped from Gmail local parts (Gmail ignores them).
 */
export function mailboxKey(address: string): string {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 1) return a;
  const domain = a.slice(at + 1);
  let local = a.slice(0, at).split("+")[0] ?? "";
  if (domain === "gmail.com" || domain === "googlemail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

function forwardedByOwner(envelopeFrom: string, ownerEmails: string | undefined): boolean {
  const owners = new Set(parseOwnerEmails(ownerEmails).map(mailboxKey));
  return owners.has(mailboxKey(envelopeFrom));
}

export async function receiveEmail(
  env: Env,
  message: ForwardableEmailMessage,
  now: string,
): Promise<void> {
  const expected = env.BILLING_ADDRESS?.trim().toLowerCase();
  if (expected && message.to.trim().toLowerCase() !== expected) {
    message.setReject("Unknown recipient");
    return;
  }
  const headerFrom = message.headers.get("from");
  if (!isGmailConfirmation(headerFrom) && !forwardedByOwner(message.from, env.OWNER_EMAILS)) {
    // The domain only: the full address may be a person's.
    console.log(`billing mailbox: refused mail from the domain ${message.from.split("@").pop()}`);
    message.setReject("Not accepted: forward invoices from the owner's mailbox");
    return;
  }
  const db = env.DB;
  const dayStart = `${now.slice(0, 10)}T00:00:00.000Z`;
  const today = await emailsSince(db, dayStart);
  if (today >= DAILY_MAIL_CAP) {
    message.setReject("Daily limit reached; try again tomorrow");
    return;
  }

  let email: Email | null = null;
  let reading: Reading | null = null;
  if (message.rawSize > MAX_EMAIL_BYTES) {
    reading = {
      ...EMPTY_READING,
      status: "review",
      note: `Too large to read (${message.rawSize} bytes).`,
    };
  } else {
    const raw = await new Response(message.raw).arrayBuffer();
    try {
      email = await PostalMime.parse(raw);
    } catch (err) {
      reading = {
        ...EMPTY_READING,
        status: "review",
        note: `Unreadable email: ${errorSummary(err)}`,
      };
    }
  }

  const messageId = email?.messageId ?? message.headers.get("message-id");
  if (messageId && (await statementExists(db, messageId))) return; // redelivered or forwarded twice

  if (email && !reading) {
    const capped = today >= DAILY_MODEL_READS;
    try {
      reading = await readEmail(
        email,
        capped ? undefined : env.AI,
        now,
        capped
          ? `Over today's limit of ${DAILY_MODEL_READS} model reads: read it by hand.`
          : undefined,
      );
    } catch (err) {
      reading = {
        ...EMPTY_READING,
        status: "review",
        note: `The model call failed: ${errorSummary(err)}`,
      };
    }
  }
  if (!reading) return; // unreachable: every branch above sets a reading or an email

  const same =
    reading.status === "recorded"
      ? await findSameCharge(db, {
          vendor: reading.vendor,
          reference: reading.reference,
          amount_cents: reading.amountCents,
          charged_on: reading.chargedOn,
        })
      : null;
  const sender = email?.from?.address ?? headerFrom;
  const subject = email?.subject ?? message.headers.get("subject");
  await insertStatement(db, {
    received_at: now,
    source: "email",
    // No Message-ID is rare; the time keeps the column unique without merging two such emails.
    message_id: messageId ?? `<no-id-${now}@${message.from}>`,
    sender: sender?.slice(0, 200) ?? null,
    subject: subject?.slice(0, 200) ?? null,
    vendor: reading.vendor,
    kind: reading.kind,
    amount_cents: reading.amountCents,
    currency: reading.currency,
    charged_on: reading.chargedOn,
    period_start: reading.periodStart,
    month: filingMonth(reading.kind, reading.periodStart, reading.chargedOn),
    reference: reading.reference,
    status: same === null ? reading.status : "duplicate",
    note: same === null ? reading.note : `Same charge as #${same}.`,
    updated_at: now,
    updated_by: "mailbox",
  });
}
