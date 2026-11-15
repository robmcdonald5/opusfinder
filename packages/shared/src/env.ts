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

// The getters themselves live in ./require-env, which a Worker may import; re-exported here for the
// Node-only env modules that also load a file.
export { requireEnv } from "./require-env";
export type { RequireEnvOptions } from "./require-env";
