import { Resend } from "resend";

import type { DigestEmailPayload } from "@opusfinder/db/repos";

import { getAlertTo, getEmailFrom, getResendApiKey, getResendApiKeyFull } from "./env";
import { renderDigestEmail } from "./render";

/**
 * The Resend transport — the ONLY file that imports the `resend` SDK, so swapping providers touches
 * one file, not a package. Errors echo SHAPE only (error name + status code) — Resend's
 * `error.message` can quote the recipient address.
 *
 * TWO clients, least-privilege: sends go through RESEND_API_KEY (may be a sending-only key); the
 * delivery-poll read goes through RESEND_API_KEY_FULL (`GET /emails/:id` 401s on a restricted key).
 */

// Lazy + memoized — same discipline as packages/llm's provider: importing the barrel must not
// require a key (the render preview + type-only consumers stay credential-free); each key is read on
// its first real use.
let sendClient: Resend | undefined;
function getSendClient(): Resend {
  sendClient ??= new Resend(getResendApiKey());
  return sendClient;
}

let readClient: Resend | undefined;
function getReadClient(): Resend {
  readClient ??= new Resend(getResendApiKeyFull());
  return readClient;
}

/**
 * The ONE idempotency-key definition: `digest/<digestId>`. Resend keeps keys 24h; a step-retry replay
 * returns the SAME email id only if the rendered payload is byte-identical (see render.ts).
 */
export const emailIdempotencyKey = (digestId: number): string => `digest/${digestId}`;

export type SendDigestResult = { emailId: string };

/**
 * Render + send one digest email. PURE transport — the SEND PERMIT is enforced UPSTREAM, so by the
 * time a payload reaches here the recipient is already approved. API errors become thrown Errors so
 * the Inngest step owns retries; a 409 `concurrent_idempotent_requests` is safe to retry.
 */
export async function sendDigestEmail(payload: DigestEmailPayload): Promise<SendDigestResult> {
  const rendered = renderDigestEmail(payload);
  const { data, error } = await getSendClient().emails.send(
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
  const { data, error } = await getReadClient().emails.get(emailId);
  if (error) {
    throw new Error(
      `resend get failed: ${error.name} (status ${String(error.statusCode ?? "network")})`,
    );
  }
  if (!data) throw new Error("resend get returned no data and no error");
  return data.last_event;
}

/**
 * Send a plain-text operator health alert. Goes to the dedicated ALERT_TO operator address via the
 * SEND key (RESEND_API_KEY) + verified EMAIL_FROM. NO idempotency key: unlike a digest, an alert is
 * not replay-idempotent — each run's verdict is its own event. Errors echo SHAPE only (name +
 * statusCode), never error.message.
 */
export async function sendHealthAlert(subject: string, text: string): Promise<{ emailId: string }> {
  const { data, error } = await getSendClient().emails.send({
    from: getEmailFrom(),
    to: getAlertTo(),
    subject,
    text,
  });
  if (error) {
    throw new Error(
      `resend alert send failed: ${error.name} (status ${String(error.statusCode ?? "network")})`,
    );
  }
  if (!data) throw new Error("resend alert send returned no data and no error");
  return { emailId: data.id };
}
