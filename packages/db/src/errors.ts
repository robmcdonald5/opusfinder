import { DrizzleQueryError } from "drizzle-orm";

// Short enough that `<source>:<slug> <reason> | <query>` fits the 500-char error_sample with room to spare.
const REASON_MAX = 200;
const QUERY_MAX = 100;
// Postgres error fields that are always identifiers (Neon's NeonDbError and PGlite both expose them).
const FIELDS = ["code", "table", "column", "constraint"] as const;
// Any `scheme://…` token (a postgres:// connection string, an https:// endpoint): kept as `scheme://[redacted]`.
const URL_RE = /\b([a-z][a-z0-9+.-]*):\/\/\S*/gi;

/**
 * An error as text for a log line or `source_runs.error_sample`, a failed QUERY's real reason first. drizzle
 * wraps every query failure in `DrizzleQueryError`, whose message is `Failed query: <SQL>\nparams: <values>`:
 * the Postgres reason (SQLSTATE, constraint, "value too long"…) rides `err.cause`, so a capped sample filled
 * with SQL text before reaching it. That error reads `[code=23505 table=jobs] <cause> | Failed query: <SQL…>`
 * instead. Any other error is its message, unchanged — an adapter's own errors (a rate limit wrapping its 429)
 * already lead with their reason.
 *
 * SECRET-SAFE: a Neon connection string can ride `err.cause` (apps/scrapers/src/index.ts), so each part keeps
 * only its FIRST line (dropping drizzle's `params:` line — job data — and any stack), anything URL-like is cut
 * to its scheme, and each part is capped. The fields are identifiers only — never `detail`, which can echo
 * row values. Only the one cause level is read (the driver's error), so no chain is walked.
 */
export function describeDbError(err: unknown): string {
  if (!(err instanceof DrizzleQueryError)) return err instanceof Error ? err.message : String(err);
  const cause: unknown = err.cause;
  let reason = "";
  if (cause != null) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const fields = fieldsOf(cause);
    reason = firstLine(fields ? `[${fields}] ${message}` : message, REASON_MAX);
  }
  return [reason, firstLine(err.message, QUERY_MAX)].filter(Boolean).join(" | ");
}

function fieldsOf(cause: unknown): string {
  if (typeof cause !== "object" || cause === null) return "";
  const r = cause as Record<string, unknown>;
  const present = FIELDS.filter((k) => typeof r[k] === "string" && r[k] !== "");
  return present.map((k) => `${k}=${r[k] as string}`).join(" ");
}

function firstLine(text: string, max: number): string {
  return (text.split(/\r?\n/)[0] ?? "").replace(URL_RE, "$1://[redacted]").slice(0, max);
}
