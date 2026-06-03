// `URL` is imported from node:url (not the ambient global) so this Node-only module still
// type-checks when it is pulled into a Cloudflare Workers typecheck context (Phase 8: the Worker
// bundles @opusfinder/embeddings → this env module). There the global `URL` is the Workers one,
// which doesn't match node:url's `fileURLToPath(string | url.URL)`; the explicit import keeps the
// Node URL type. Runtime is unchanged — in Node the two URLs are identical.
import { fileURLToPath, URL } from "node:url";

import { config } from "dotenv";

/**
 * Load a package's own `.env`, resolved relative to the CALLING module (pass
 * `import.meta.url` from a file in the package's `src/`), NOT the cwd. A package's own
 * scripts run with that package as cwd, but cross-package callers import these guards
 * from their own directories — a cwd-relative load would silently miss the file and
 * leave the var undefined. `fileURLToPath` (not a raw `file://` string) keeps the
 * Windows drive-letter path valid. `quiet` silences dotenv@17's load banner. dotenv
 * does NOT override an already-set process env var, so a real value in the shell wins.
 *
 * Assumes the caller lives one level below the package root (`src/env.ts`), so `../.env`
 * lands on `packages/<pkg>/.env`. A file AT the package root (e.g. drizzle.config.ts)
 * must NOT use this — it would resolve `../.env` one directory too high.
 */
export function loadPackageEnv(metaUrl: string): void {
  config({ path: fileURLToPath(new URL("../.env", metaUrl)), quiet: true });
}

export interface RequireEnvOptions {
  /** The environment variable name, e.g. "DATABASE_URL". */
  name: string;
  /** Friendly, actionable message thrown when the var is missing or blank. */
  notSet: string;
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
 * still seen), like the per-package getters it replaces.
 */
export function requireEnv(opts: RequireEnvOptions): () => string {
  return () => {
    const value = process.env[opts.name]?.trim();
    if (!value) throw new Error(opts.notSet);
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
