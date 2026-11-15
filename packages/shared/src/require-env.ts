/**
 * Getters for required environment variables. Worker-safe to import: no Node builtins, no file reads,
 * and `process.env` is touched only when a getter is CALLED. Loading a package's `.env` file is
 * `loadPackageEnv` in ./env (Node-only).
 */

export interface RequireEnvOptions {
  /** The environment variable name, e.g. "DATABASE_URL". */
  name: string;
  /** Friendly, actionable message thrown when the var is missing or blank. */
  notSetMessage: string;
  /**
   * Optional hard format check, run after the presence check. Throw (with a
   * secret-free message — echo only non-sensitive shape) to reject a malformed value;
   * e.g. db rejects a non-Postgres URL while echoing only the scheme, never the
   * credentials. Return normally to accept.
   */
  validate?: (value: string) => void;
  /**
   * Optional soft sanity check: warn (NEVER throw) when the value doesn't start with
   * this prefix — provider key prefixes can change and the provider is the real
   * authority. The warning echoes only non-sensitive shape (presence, length, prefix),
   * never the value itself.
   */
  prefix?: string;
}

/**
 * Build a getter that reads + validates one required env var. Centralizes the
 * trim → presence-throw → optional hard-validate → optional soft-prefix-warn policy so
 * every package shares ONE friendly, actionable error (and one no-secrets-in-logs rule)
 * instead of a per-package copy that drifts. Throws on a missing or malformed value;
 * never returns a bad one. Reads `process.env` on each call (so a late-loaded var is
 * still seen), like the per-package getters it replaces. In a runtime with no `process` (a Cloudflare
 * Worker without `nodejs_compat`) the var reads as missing: a Worker passes its config in as parameters.
 */
export function requireEnv(opts: RequireEnvOptions): () => string {
  return () => {
    const value = (typeof process === "undefined" ? undefined : process.env[opts.name])?.trim();
    if (!value) throw new Error(opts.notSetMessage);
    opts.validate?.(value);
    if (opts.prefix && !value.startsWith(opts.prefix)) {
      console.warn(
        `${opts.name} is set (length ${value.length}) but does not start with "${opts.prefix}"; ` +
          "proceeding anyway.",
      );
    }
    return value;
  };
}
