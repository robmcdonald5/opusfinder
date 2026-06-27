import { loadPackageEnv, requireEnv } from "@opusfinder/shared/env";

// Load packages/email/.env relative to THIS module (see loadPackageEnv), so cross-package callers
// (the Inngest serve process, the trigger CLI) pick up the Resend config from their own directories
// too. Node/server-only — this package is deny-listed from the scrapers Worker (guard:worker).
loadPackageEnv(import.meta.url);

/**
 * Read + validate RESEND_API_KEY — the SEND key. Least-privilege split: this one may be a Resend
 * "sending access"-only key (it only ever does `POST /emails`); status READS use
 * {@link getResendApiKeyFull}. The soft "re_" prefix check warns but never hard-fails (prefixes can
 * change; the provider is the real authority) and echoes only non-sensitive shape, never the key.
 */
export const getResendApiKey = requireEnv({
  name: "RESEND_API_KEY",
  notSetMessage:
    "RESEND_API_KEY is not set. Paste your Resend API key into packages/email/.env " +
    "(RESEND_API_KEY=re_...), or export it as an environment variable.",
  prefix: "re_",
});

/**
 * Read + validate RESEND_API_KEY_FULL — the READ key for the post-send delivery poll
 * (`GET /emails/:id`). A restricted sending-only key 401s (`restricted_api_key`) on that endpoint, so
 * the poll requires a FULL-access key, explicitly named. (Single-key setups just put the same
 * full-access value in both vars.)
 */
export const getResendApiKeyFull = requireEnv({
  name: "RESEND_API_KEY_FULL",
  notSetMessage:
    "RESEND_API_KEY_FULL is not set. The delivery poll reads email status back, which a " +
    "sending-only key cannot (Resend 401 restricted_api_key) — create a FULL-access key and put it " +
    "in packages/email/.env (RESEND_API_KEY_FULL=re_...).",
  prefix: "re_",
});

/** The verified sender, display-name form — e.g. `opusfinder digest <digest@send.opusfinder.ai>`.
 *  The domain must be verified on Resend (SPF/DKIM/DMARC) or every send 403s. */
export const getEmailFrom = requireEnv({
  name: "EMAIL_FROM",
  notSetMessage:
    "EMAIL_FROM is not set. Set the verified sender in packages/email/.env, " +
    "e.g. EMAIL_FROM=opusfinder digest <digest@send.opusfinder.ai>.",
});

/**
 * The dedicated operator address health alerts go to ({@link import("./transport").sendHealthAlert}) —
 * the owner AS operator, not a product user. FAIL-LOUD: requireEnv throws if unset, never silently
 * drops an alert.
 */
export const getAlertTo = requireEnv({
  name: "ALERT_TO",
  notSetMessage:
    "ALERT_TO is not set — the operator address health alerts are sent to. Set ALERT_TO=you@example.com " +
    "in packages/email/.env (a dedicated operator address).",
});

// The digest SEND PERMIT lives in the DB: the per-user `user_preferences.digest_approved_at` gate
// (see packages/db/src/repos/preferences.ts `setDigestApproval`).
