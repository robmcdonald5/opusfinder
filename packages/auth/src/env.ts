import { loadPackageEnv, requireEnv } from "@opusfinder/shared/env";

// Node-only env readers for Better Auth. Imported ONLY by the auth scripts/service (this module runs
// loadPackageEnv at load), NEVER by a Worker-bound module — Better Auth itself crashes at import under
// `nodejs_compat` (#6665), so this `./env` subpath is the node-only boundary, the same discipline as
// `@opusfinder/storage/env`. Loads packages/auth/.env relative to THIS module (see loadPackageEnv).
loadPackageEnv(import.meta.url);

/** The Better Auth signing secret. Required; self-generated, never committed (lives in .env). */
export const getAuthSecret = requireEnv({
  name: "BETTER_AUTH_SECRET",
  notSet:
    "BETTER_AUTH_SECRET is not set. Generate one (`openssl rand -base64 32`) and paste it into packages/auth/.env (git-ignored).",
});

/**
 * Better Auth's base URL. The lib builds URLs internally even when called headless (no HTTP handler
 * mounted), so `createAuth` needs a concrete value — pre-UI a localhost placeholder is fine; the real
 * value lands when the Phase-12 SvelteKit handler mounts. Defaults to http://localhost:5173 when
 * BETTER_AUTH_URL is unset/blank, so CLI seeding works with no extra config.
 */
export function getAuthBaseURL(): string {
  return process.env.BETTER_AUTH_URL?.trim() || "http://localhost:5173";
}
