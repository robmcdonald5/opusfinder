import { Resend } from "resend";

import type { DigestEmailPayload } from "@opusfinder/db/repos";

import { getAlertTo, getEmailFrom, getResendApiKey, getResendApiKeyFull } from "./env";
import { renderDigestEmail } from "./render";

/**
 * The Resend transport — the ONLY file that imports the `resend` SDK, so the end-of-phase
 * "Resend vs alternative" evaluation swaps one file, not a package. Errors echo SHAPE only
 * (error name + status code) — Resend's `error.message` can quote the recipient address.
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
 * The ONE idempotency-key definition (the `synthId` discipline): `digest/<digestId>`. Resend keeps
 * keys 24h; a step-retry replay returns the SAME email id without a second send — but only if the
 * rendered payload is byte-identical (see render.ts). Exported so the stub smoke locks the shape.
 */
export const emailIdempotencyKey = (digestId: number): string => `digest/${digestId}`;

export type SendDigestResult = { emailId: string };

/**
 * Render + send one digest email. This is a PURE transport — the SEND PERMIT is enforced UPSTREAM (the
 * DB-native `user_preferences.digest_approved_at` gate, checked at recipient resolution + the digest load
 * step + re-asserted at the send boundary in deliverDigestEmail), so by the time a payload reaches here the
 * recipient is already approved; this function just renders + sends. API errors become thrown Errors so the
 * Inngest step owns retries (transient 429/5xx) or exhausts into the caller's terminalize catch; a 409
 * `concurrent_idempotent_requests` is safe to retry by Resend's own contract, so the plain throw → step
 * retry is exactly right.
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
 * Send a plain-text operator health alert (Phase F6) — the `pnpm health` CLI calls this when an
 * enforce-mode check fires. Reuses the lazy send client (RESEND_API_KEY — the SEND key, never the FULL
 * read key) + the verified EMAIL_FROM, and goes to the dedicated ALERT_TO operator address (NOT the
 * digest allowlist — decoupled so the alert can never be the silently-broken thing). NO idempotency
 * key: unlike a digest, an alert is not replay-idempotent — each run's verdict is its own event. The
 * body is whatever the caller passes (shape-only by construction at the call site); errors echo SHAPE
 * only (name + statusCode), never error.message.
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
