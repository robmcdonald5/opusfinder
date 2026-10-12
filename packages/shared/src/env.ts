import { readFileSync } from "node:fs";
// `URL` is imported from node:url (not the ambient global) so this Node-only module still
// type-checks when pulled into a Cloudflare Workers typecheck context: there the global `URL` is
// the Workers one, which doesn't match node:url's `fileURLToPath(string | url.URL)`. The explicit
// import keeps the Node URL type; runtime is unchanged (in Node the two URLs are identical).
import { fileURLToPath, URL } from "node:url";

import { parse } from "dotenv";

/**
 * Load a package's own `.env`, resolved relative to the CALLING module (pass `import.meta.url`
 * from a file in the package's `src/`), NOT the cwd — a cwd-relative load would silently miss the
 * file when a cross-package caller imports this guard. `fileURLToPath` keeps the Windows
 * drive-letter path valid. An already-set var is never overridden, so a shell value wins.
 *
 * A blank `KEY=` line is skipped: every package's `.env` loads into the one `process.env` and the
 * first to set a key wins, so a blank template line in one package would hide another's real value.
 *
 * Assumes the caller lives one level below the package root (`src/env.ts`), so `../.env` lands on
 * `packages/<pkg>/.env`. A file AT the package root (e.g. drizzle.config.ts) must NOT use this — it
 * would resolve `../.env` one directory too high.
 */
export function loadPackageEnv(metaUrl: string): void {
  // In a Cloudflare Worker there is no filesystem and `import.meta.url` is not a resolvable file URL,
  // so resolving the `.env` path throws; env there comes from runtime bindings, not a file.
  let envPath: string;
  try {
    envPath = fileURLToPath(new URL("../.env", metaUrl));
  } catch {
    return;
  }
  let text: string;
  try {
    text = readFileSync(envPath, "utf8");
  } catch (err) {
    // A missing file is the normal case. Any other failure would otherwise surface only as
    // "X is not set", pointing the reader at a file that already exists.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(`Could not read ${envPath} (${code}); using the ambient environment.`);
    }
    return;
  }
  for (const [key, value] of Object.entries(parse(text))) {
    if (value && process.env[key] === undefined) process.env[key] = value;
  }
}

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
 * still seen), like the per-package getters it replaces.
 */
export function requireEnv(opts: RequireEnvOptions): () => string {
  return () => {
    const value = process.env[opts.name]?.trim();
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
