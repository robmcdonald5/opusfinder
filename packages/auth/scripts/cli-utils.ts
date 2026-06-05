// Small argv-parsing helpers shared by the user-management CLIs (user-create / user-set-prefs).
// Flag values arrive as strings (node:util parseArgs); these validate + coerce them, throwing an
// actionable error (no secrets) on bad input, and build the shared UserPreferences patch.
import type { DigestCadence, UserPreferences } from "@opusfinder/shared";

export function parseBool(value: string, flag: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${flag} must be "true" or "false" (got ${JSON.stringify(value)})`);
}

export function parseIntFlag(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n))
    throw new Error(`--${flag} must be an integer (got ${JSON.stringify(value)})`);
  return n;
}

const CADENCES: readonly DigestCadence[] = ["daily", "weekly", "monthly"];
export function parseCadence(value: string): DigestCadence {
  if ((CADENCES as readonly string[]).includes(value)) return value as DigestCadence;
  throw new Error(`--cadence must be one of ${CADENCES.join("|")} (got ${JSON.stringify(value)})`);
}

/** Comma-separated list → trimmed, non-empty parts. */
export function parseList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Mask an email's local part for log output (PII discipline — same spirit as the secret-shape rule):
 * `jane@example.com` → `j***e@example.com`. Enough to recognize a row without dumping the full address.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `${local[0] ?? "*"}***${domain}`;
  return `${local[0]}***${local[local.length - 1]}${domain}`;
}

/** Build a UserPreferences patch from the (already string-typed) preference flags; omits unset ones. */
export function prefsFromFlags(
  values: Record<string, string | undefined>,
): Partial<UserPreferences> {
  const prefs: Partial<UserPreferences> = {};
  if (values.remote !== undefined) prefs.remoteOk = parseBool(values.remote, "remote");
  if (values.locations !== undefined) prefs.locations = parseList(values.locations);
  if (values["min-salary"] !== undefined)
    prefs.minSalary = parseIntFlag(values["min-salary"], "min-salary");
  if (values["recency-days"] !== undefined)
    prefs.recencyDays = parseIntFlag(values["recency-days"], "recency-days");
  if (values.cadence !== undefined) prefs.digestCadence = parseCadence(values.cadence);
  if (values.enabled !== undefined) prefs.digestEnabled = parseBool(values.enabled, "enabled");
  return prefs;
}
