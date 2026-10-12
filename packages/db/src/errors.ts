export { describeDbError } from "@opusfinder/shared/errors";

/** The constraint a failed query violated: drizzle carries the driver error (Neon's or PGlite's) as `cause`. */
export function pgConstraintOf(err: unknown): string | undefined {
  const cause: unknown = err instanceof Error ? err.cause : undefined;
  if (typeof cause !== "object" || cause === null) return undefined;
  const constraint = (cause as Record<string, unknown>).constraint;
  return typeof constraint === "string" ? constraint : undefined;
}
