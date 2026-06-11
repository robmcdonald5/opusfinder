import { loadPackageEnv, requireEnv } from "@opusfinder/shared/env";

// Load packages/email/.env relative to THIS module (see loadPackageEnv), so cross-package callers
// (the Inngest serve process, the trigger CLI) pick up the Resend config from their own directories
// too. Node/server-only — this package is deny-listed from the scrapers Worker (guard:worker).
loadPackageEnv(import.meta.url);

/**
 * Read + validate RESEND_API_KEY. The soft "re_" prefix check warns but never hard-fails (prefixes
 * can change; the provider is the real authority) and echoes only non-sensitive shape, never the key.
 */
export const getResendApiKey = requireEnv({
  name: "RESEND_API_KEY",
  notSet:
    "RESEND_API_KEY is not set. Paste your Resend API key into packages/email/.env " +
    "(RESEND_API_KEY=re_...), or export it as an environment variable.",
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

const getEmailAllowlistRaw = requireEnv({
  name: "EMAIL_ALLOWLIST",
  notSet:
    "EMAIL_ALLOWLIST is not set — refusing to send (fail-closed until the Phase-12 signup flow). " +
    "Set a comma-separated recipient allowlist in packages/email/.env.",
});

/**
 * The parsed (lowercased, trimmed) recipient allowlist. FAIL-CLOSED (Phase-11 guard): missing or
 * effectively-empty config THROWS rather than running half-guarded — `digest_enabled` defaults true,
 * so without this gate any verified user in the dev DB would get real email on an `--all` sweep.
 * Removed in Phase 12 with the real signup flow.
 */
export function getEmailAllowlist(): string[] {
  const list = getEmailAllowlistRaw()
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (list.length === 0) {
    throw new Error("EMAIL_ALLOWLIST is empty — refusing to send (fail-closed).");
  }
  return list;
}
