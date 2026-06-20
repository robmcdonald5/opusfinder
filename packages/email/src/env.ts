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
  notSet:
    "RESEND_API_KEY is not set. Paste your Resend API key into packages/email/.env " +
    "(RESEND_API_KEY=re_...), or export it as an environment variable.",
  prefix: "re_",
});

/**
 * Read + validate RESEND_API_KEY_FULL — the READ key for the post-send delivery poll
 * (`GET /emails/:id`). A restricted sending-only key 401s (`restricted_api_key`) on that endpoint —
 * observed live at the Phase-11 gate — so the poll requires a FULL-access key, explicitly named.
 * (Single-key setups just put the same full-access value in both vars.) Phase 12's webhooks replace
 * the poll and need no read access; this var retires with it.
 */
export const getResendApiKeyFull = requireEnv({
  name: "RESEND_API_KEY_FULL",
  notSet:
    "RESEND_API_KEY_FULL is not set. The delivery poll reads email status back, which a " +
    "sending-only key cannot (Resend 401 restricted_api_key) — create a FULL-access key and put it " +
    "in packages/email/.env (RESEND_API_KEY_FULL=re_...).",
  prefix: "re_",
});

/** The verified sender, display-name form — e.g. `opusfinder digest <digest@send.opusfinder.ai>`.
 *  The domain must be verified on Resend (SPF/DKIM/DMARC) or every send 403s. */
export const getEmailFrom = requireEnv({
  name: "EMAIL_FROM",
  notSet:
    "EMAIL_FROM is not set. Set the verified sender in packages/email/.env, " +
    "e.g. EMAIL_FROM=opusfinder digest <digest@send.opusfinder.ai>.",
});

/**
 * The operator address Phase-F6 health alerts go to ({@link import("./transport").sendHealthAlert}).
 * A DEDICATED operator address — the owner AS operator, not a product user. FAIL-LOUD: requireEnv throws
 * if unset, so `pnpm health` logs + exits non-zero rather than silently dropping an alert.
 */
export const getAlertTo = requireEnv({
  name: "ALERT_TO",
  notSet:
    "ALERT_TO is not set — the operator address health alerts are sent to. Set ALERT_TO=you@example.com " +
    "in packages/email/.env (a dedicated operator address).",
});

// The digest SEND PERMIT is no longer an env allowlist: it moved to the DB-native, per-user
// `user_preferences.digest_approved_at` gate (migration 0022), checked at recipient resolution + the
// digest load step (before any paid spend) and re-asserted at the send boundary in @opusfinder/inngest's
// deliverDigestEmail. See packages/db/src/repos/preferences.ts `setDigestApproval` + `pnpm user:approve`.
