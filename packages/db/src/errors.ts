import { DrizzleQueryError } from "drizzle-orm";

// Short enough that `<source>:<slug> <reason> | <query>` fits the 500-char error_sample with room to spare.
const REASON_MAX = 200;
const QUERY_MAX = 100;
// Postgres error fields that are always identifiers (Neon's NeonDbError and PGlite both expose them).
const FIELDS = ["code", "table", "column", "constraint"] as const;
// Any `scheme://…` token (a postgres:// connection string, an https:// endpoint): kept as `scheme://[redacted]`.
const URL_RE = /\b([a-z][a-z0-9+.-]*):\/\/\S*/gi;
// A libpq keyword-form password (`password=s3cret`, `password = 'two words'`): kept as `password=[redacted]`.
const PASSWORD_RE = /(password)\s*=\s*(?:'(?:[^'\\]|\\.)*'|\S*)/gi;

/**
 * An error as text for a log line or `source_runs.error_sample`, a failed QUERY's real reason first. drizzle
 * wraps every query failure in `DrizzleQueryError`, whose message is `Failed query: <SQL>\nparams: <values>`:
 * the Postgres reason (SQLSTATE, constraint, "value too long"…) rides `err.cause`, so a capped sample filled
 * with SQL text before reaching it. That error reads `[code=23505 table=jobs] <cause> | Failed query: <SQL…>`
 * instead. Any other error is its message, unchanged — an adapter's own errors (a rate limit wrapping its 429)
 * already lead with their reason.
 *
 * SECRET-SAFE FOR THE DrizzleQueryError PATH ONLY: a Neon connection string can ride `err.cause`
 * (apps/scrapers/src/index.ts), so the cause keeps only its FIRST line (no stack or trailing detail), URL-like
 * tokens are cut to their scheme, a keyword-form `password=` is cut, and each part is capped. The SQL comes
 * from `err.query`, never `err.message`, so drizzle's `params:` line (job data) is never read. The fields are
 * identifiers only — never `detail`, which can echo row values. Only the one cause level is read (the driver's
 * error), so no chain is walked. Any OTHER error is returned as is: its caller's own discipline applies.
 */
export function describeDbError(err: unknown): string {
  if (!(err instanceof DrizzleQueryError)) return err instanceof Error ? err.message : String(err);
  const cause: unknown = err.cause;
  let reason = "";
  if (cause != null) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const fields = fieldsOf(cause);
    const line = (fields ? `[${fields}] ${message}` : message).split(/\r?\n/)[0] ?? "";
    reason = redact(line).slice(0, REASON_MAX);
  }
  // Whitespace collapsed: many repo queries are multi-line `sql` templates that START with a newline.
  const sql = err.query.replace(/\s+/g, " ").trim();
  const query = redact(`Failed query: ${sql}`).slice(0, QUERY_MAX);
  return [reason, query].filter(Boolean).join(" | ");
}

function fieldsOf(cause: unknown): string {
  if (typeof cause !== "object" || cause === null) return "";
  const r = cause as Record<string, unknown>;
  const present = FIELDS.filter((k) => typeof r[k] === "string" && r[k] !== "");
  return present.map((k) => `${k}=${r[k] as string}`).join(" ");
}

function redact(text: string): string {
  return text.replace(URL_RE, "$1://[redacted]").replace(PASSWORD_RE, "$1=[redacted]");
}
