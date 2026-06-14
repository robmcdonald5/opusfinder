// Small argv-parsing helpers shared by the user-management CLIs (user-create / user-set-prefs).
// Flag values arrive as strings (node:util parseArgs); these validate + coerce them, throwing an
// actionable error (no secrets) on bad input, and build the shared UserPreferences patch.
import type { DigestCadence, LocationMode, UserPreferences } from "@opusfinder/shared";

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

const LOCATION_MODES: readonly LocationMode[] = ["any", "remote_only", "onsite_only"];
export function parseLocationMode(value: string): LocationMode {
  if ((LOCATION_MODES as readonly string[]).includes(value)) return value as LocationMode;
  throw new Error(`--location-mode must be one of ${LOCATION_MODES.join("|")} (got ${JSON.stringify(value)})`);
}

/** A nullable integer flag: the literal "clear" (or an empty string) sets the column to NULL ("no bound");
 *  anything else parses as an integer. parseIntFlag alone can't express a clear — Number("") is 0, a wrong
 *  value not an absent one — so the nullable min/max bounds route through here. */
export function parseNullableInt(value: string, flag: string): number | null {
  if (value === "clear" || value === "") return null;
  return parseIntFlag(value, flag);
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

/** Build a UserPreferences patch from the (already string-typed) preference flags; omits unset ones. The
 *  nullable bounds (min/max salary, min/max yoe) accept "clear" to write NULL; "" empties an array
 *  (dealbreakers/exclusions). Phase F3 added location-mode/max-salary/min-yoe/max-yoe/dealbreakers +
 *  closed the long-standing exclusions CLI gap. */
export function prefsFromFlags(
  values: Record<string, string | undefined>,
): Partial<UserPreferences> {
  const prefs: Partial<UserPreferences> = {};
  if (values["location-mode"] !== undefined) prefs.locationMode = parseLocationMode(values["location-mode"]);
  if (values.locations !== undefined) prefs.locations = parseList(values.locations);
  if (values["min-salary"] !== undefined) prefs.minSalary = parseNullableInt(values["min-salary"], "min-salary");
  if (values["max-salary"] !== undefined) prefs.maxSalary = parseNullableInt(values["max-salary"], "max-salary");
  if (values["min-yoe"] !== undefined) prefs.yoeMin = parseNullableInt(values["min-yoe"], "min-yoe");
  if (values["max-yoe"] !== undefined) prefs.yoeMax = parseNullableInt(values["max-yoe"], "max-yoe");
  if (values["recency-days"] !== undefined)
    prefs.recencyDays = parseIntFlag(values["recency-days"], "recency-days");
  if (values.exclusions !== undefined) prefs.exclusions = parseList(values.exclusions);
  if (values.dealbreakers !== undefined) prefs.dealbreakers = parseList(values.dealbreakers);
  if (values.cadence !== undefined) prefs.digestCadence = parseCadence(values.cadence);
  if (values.enabled !== undefined) prefs.digestEnabled = parseBool(values.enabled, "enabled");
  // Partial cross-field guard (min must not exceed max). Only catches BOTH bounds passed in THIS
  // invocation — it cannot see a bound already stored from a prior call; full validation is the form's job.
  assertOrdered(prefs.minSalary, prefs.maxSalary, "min-salary", "max-salary");
  assertOrdered(prefs.yoeMin, prefs.yoeMax, "min-yoe", "max-yoe");
  return prefs;
}

/** Throw if both bounds are present numbers and min > max (a partial, same-invocation check). */
function assertOrdered(
  min: number | null | undefined,
  max: number | null | undefined,
  minFlag: string,
  maxFlag: string,
): void {
  if (typeof min === "number" && typeof max === "number" && min > max) {
    throw new Error(`--${minFlag} (${min}) must not exceed --${maxFlag} (${max})`);
  }
}
