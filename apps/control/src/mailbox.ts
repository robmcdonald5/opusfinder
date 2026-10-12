import PostalMime, { addressParser, type Email } from "postal-mime";

import { parseOwnerEmails } from "./auth-config";
import type { Env } from "./env";
import {
  DAILY_CONFIRMATION_CAP,
  DAILY_MAIL_CAP,
  DAILY_MODEL_READS,
  MAX_EMAIL_BYTES,
} from "./limits";
import { errorSummary } from "./service";
import {
  EMPTY_READING,
  GMAIL_FORWARDING_SENDER,
  authSummary,
  filingMonth,
  isGmailConfirmation,
  readConfirmation,
  readEmail,
  type Reading,
} from "./statements";
import { findSameCharge, insertStatement, mailCountsSince, statementExists } from "./store";

/**
 * The billing mailbox: Email Routing delivers each email sent to the billing address (the owner's Gmail
 * filter forwards vendor invoices there) to this Worker's email() handler, which records one statement row.
 *
 * Who may write here: only mail whose ENVELOPE sender is one of the owner's addresses (a Gmail forward keeps
 * the forwarding account as the envelope sender; Cloudflare's docs call `message.from` the trustworthy
 * one — header addresses can be spoofed), plus Gmail's forwarding confirmation, which the owner needs to see.
 * Everything else is refused at the SMTP stage: no row, no model read. The envelope sender can still be
 * forged (README), so until the gate also checks the mail's authentication, nothing read from an email
 * counts by itself: every charge waits in review for the owner, pre-filled with what the model read.
 *
 * Once accepted, a vendor's invoice is never lost for a reason of ours: anything unreadable is still
 * recorded, for the owner to review on the Cost page. A database error is NOT swallowed: email() throws, and
 * what Email Routing then does with the email isn't documented (it may be lost).
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

/** Every address in a From header ("Name" <a@b>, groups flattened), lowercase. */
function fromHeaderAddresses(header: string | null): string[] {
  return addressParser(header ?? "")
    .flatMap((a) => (a.group ? a.group : [a]))
    .map((a) => (a.address ?? "").trim().toLowerCase())
    .filter((a) => a.length > 0);
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
  if (!expected || message.to.trim().toLowerCase() !== expected) {
    message.setReject("Unknown recipient");
    return;
  }
  // One From address, or nothing: with two, the gate and the parser could each see a different one.
  const fromAddresses = fromHeaderAddresses(message.headers.get("from"));
  if (fromAddresses.length !== 1) {
    message.setReject("Not accepted: exactly one From address");
    return;
  }
  // Decided once, here: mail the owner forwarded is read as a possible bill; mail let in only as Gmail's
  // forwarding confirmation is only ever filed as that confirmation (never read by the model, never counted).
  const fromOwner = forwardedByOwner(message.from, env.OWNER_EMAILS);
  const confirmation = !fromOwner && isGmailConfirmation(fromAddresses[0]);
  if (!fromOwner && !confirmation) {
    // The domain only: the full address may be a person's.
    console.log(`billing mailbox: refused mail from the domain ${message.from.split("@").pop()}`);
    message.setReject("Not accepted: forward invoices from the owner's mailbox");
    return;
  }
  const db = env.DB;
  const dayStart = `${now.slice(0, 10)}T00:00:00.000Z`;
  const counts = await mailCountsSince(db, dayStart, GMAIL_FORWARDING_SENDER);
  if (
    confirmation
      ? counts.confirmations >= DAILY_CONFIRMATION_CAP
      : counts.forwards >= DAILY_MAIL_CAP
  ) {
    message.setReject("Not accepted: today's limit for this mailbox is reached");
    return;
  }
  let email: Email | null = null;
  let failure: string | null = null;
  if (message.rawSize > MAX_EMAIL_BYTES) {
    failure = `Too large to read (${message.rawSize} bytes).`;
  } else {
    const raw = await new Response(message.raw).arrayBuffer();
    try {
      email = await PostalMime.parse(raw);
    } catch (err) {
      failure = `Unreadable email: ${errorSummary(err)}`;
    }
  }
  // From the parsed header list, not message.headers: Headers.get joins every copy of a header into one,
  // which loses which server wrote which verdict.
  const auth = email ? authSummary(email.headers) : null;
  console.log(
    `billing mailbox: accepted ${confirmation ? "a Gmail confirmation" : "an owner forward"}; auth: ${auth ?? "none recorded"}`,
  );

  const messageId = (email?.messageId ?? message.headers.get("message-id"))?.slice(0, 200);
  if (messageId && (await statementExists(db, messageId))) return; // redelivered or forwarded twice

  let reading: Reading;
  if (confirmation) {
    reading = readConfirmation(email);
  } else if (!email) {
    reading = { ...EMPTY_READING, status: "review", note: failure };
  } else {
    const capped = counts.forwards >= DAILY_MODEL_READS;
    try {
      reading = await readEmail(
        email,
        capped ? undefined : env.AI,
        now,
        capped
          ? `Over today's limit of ${DAILY_MODEL_READS} emails read by the model: read it by hand.`
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

  // Rows still waiting match too: nothing read from an email counts by itself, so an invoice and its receipt
  // would otherwise both wait unflagged, and both be counted.
  const same =
    reading.status === "recorded"
      ? await findSameCharge(
          db,
          {
            vendor: reading.vendor,
            reference: reading.reference,
            amount_cents: reading.amountCents,
            charged_on: reading.chargedOn,
          },
          { alsoWaiting: true },
        )
      : null;
  // A confirmation's sender is stored as exactly Gmail's address: that is what marks the row as one.
  const sender = confirmation
    ? GMAIL_FORWARDING_SENDER
    : (email?.from?.address ?? fromAddresses[0]);
  const subject = email?.subject ?? message.headers.get("subject");
  await insertStatement(db, {
    received_at: now,
    source: "email",
    // No Message-ID is rare; the time keeps the column unique without merging two such emails.
    message_id: messageId ?? `<no-id-${now}@billing-mailbox>`,
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
    // Even a clean reading waits for the owner (see the top of this file).
    status: same !== null ? "duplicate" : reading.status === "recorded" ? "review" : reading.status,
    note: same === null ? reading.note : `Same charge as #${same}.`,
    auth,
    updated_at: now,
    updated_by: "mailbox",
  });
}
