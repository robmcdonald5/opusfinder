import { Resend } from "resend";

import type { DigestEmailPayload } from "@opusfinder/db/repos";

import { getEmailAllowlist, getEmailFrom, getResendApiKey } from "./env";
import { renderDigestEmail } from "./render";

/**
 * The Resend transport — the ONLY file that imports the `resend` SDK, so the end-of-phase
 * "Resend vs alternative" evaluation swaps one file, not a package. Errors echo SHAPE only
 * (error name + status code) — Resend's `error.message` can quote the recipient address.
 */

// Lazy + memoized — same discipline as packages/llm's provider: importing the barrel must not
// require a key (the render preview + type-only consumers stay credential-free); the key is read on
// the first real send/get.
let client: Resend | undefined;
function getClient(): Resend {
  client ??= new Resend(getResendApiKey());
  return client;
}

/**
 * The ONE idempotency-key definition (the `synthId` discipline): `digest/<digestId>`. Resend keeps
 * keys 24h; a step-retry replay returns the SAME email id without a second send — but only if the
 * rendered payload is byte-identical (see render.ts). Exported so the stub smoke locks the shape.
 */
export const emailIdempotencyKey = (digestId: number): string => `digest/${digestId}`;

export type SendDigestResult = { emailId: string } | { skipped: "allowlist" };

/**
 * Render + send one digest email. Allowlist FIRST and fail-closed (missing config throws via
 * `getEmailAllowlist`); an unlisted recipient is a recorded skip — nothing is sent and the API key
 * is never even read. API errors become thrown Errors so the Inngest step owns retries (transient
 * 429/5xx) or exhausts into the caller's terminalize catch; a 409 `concurrent_idempotent_requests`
 * is safe to retry by Resend's own contract, so the plain throw → step retry is exactly right.
 */
export async function sendDigestEmail(payload: DigestEmailPayload): Promise<SendDigestResult> {
  const allowlist = getEmailAllowlist();
  const to = payload.recipient.email.trim().toLowerCase();
  if (!allowlist.includes(to)) {
    console.log(
      `email: recipient not allowlisted (len ${to.length}) — skipping digest ${payload.digestId}`,
    );
    return { skipped: "allowlist" };
  }

  const rendered = renderDigestEmail(payload);
  const { data, error } = await getClient().emails.send(
    {
      from: getEmailFrom(),
      to: payload.recipient.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    },
    { idempotencyKey: emailIdempotencyKey(payload.digestId) },
  );
  if (error) {
    // The SDK never throws for API errors — it returns { data: null, error }. Convert to a throw.
    // SHAPE ONLY: name + statusCode, never error.message (it can quote the address).
    throw new Error(
      `resend send failed: ${error.name} (status ${String(error.statusCode ?? "network")}) for digest ${payload.digestId}`,
    );
  }
  if (!data) {
    throw new Error(`resend send returned no data and no error (digest ${payload.digestId})`);
  }
  return { emailId: data.id };
}

/**
 * The delivery state of a sent email — `GET /emails/:id` → `last_event` (e.g. `sent`, `delivered`,
 * `delivery_delayed`, `bounced`, `complained`, `failed`). The event→status POLICY lives in
 * @opusfinder/inngest; this is a pure passthrough.
 */
export async function getEmailLastEvent(emailId: string): Promise<string> {
  const { data, error } = await getClient().emails.get(emailId);
  if (error) {
    throw new Error(
      `resend get failed: ${error.name} (status ${String(error.statusCode ?? "network")})`,
    );
  }
  if (!data) throw new Error("resend get returned no data and no error");
  return data.last_event;
}
