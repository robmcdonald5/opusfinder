/**
 * The cap on a request body, in BYTES (enforced by readBody() in index.ts). Its own runtime-neutral module
 * so the integration suite can import the real value: the Worker's main module may export only handlers
 * and classes.
 */
export const MAX_BODY_BYTES = 16 * 1024;

/** The billing mailbox: bigger than any invoice email; a larger message is recorded unread, never parsed. */
export const MAX_EMAIL_BYTES = 10 * 1024 * 1024;
/**
 * Emails the model reads per UTC day, each costing at most two model calls and one PDF conversion. Past
 * it, emails wait for the owner (a runaway guard on Workers AI spend).
 */
export const DAILY_MODEL_READS = 50;
/**
 * The owner's forwards the billing mailbox accepts per UTC day. Past it, mail is refused at the SMTP stage:
 * nothing legitimate sends this many invoices, and the statement table must not grow without bound.
 */
export const DAILY_MAIL_CAP = 100;
/**
 * Gmail forwarding confirmations accepted per UTC day, counted apart from the owner's forwards: anyone can
 * write that From header, so junk "confirmations" must never use up the owner's quota.
 */
export const DAILY_CONFIRMATION_CAP = 5;
