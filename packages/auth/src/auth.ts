import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import type { AuthDb } from "@opusfinder/db/auth-client";

/**
 * Construct a Better Auth instance bound to OUR Neon DB via the Drizzle adapter. Env-free: the db +
 * secret + baseURL are INJECTED (no `process.env` in `src/`), mirroring the `createDb` / `ingestCv`
 * seams, so the same factory backs the CLI now and the Phase-12 SvelteKit action later.
 *
 * NODE/SERVER-ONLY. Better Auth crashes at import under Cloudflare `nodejs_compat` (issue #6665), so
 * this module — and anything that imports it — must NEVER enter the scrapers Worker bundle. The
 * Worker reads Neon directly as a trusted process and never touches `@opusfinder/auth`.
 *
 * `authDb` MUST be the neon-serverless handle (`createAuthDb`), not the neon-http `createDb`:
 * `signUpEmail` wraps the `user`+`account` inserts in an interactive transaction neon-http cannot run
 * (decision B1, neon #4747).
 */
export function createAuth(authDb: AuthDb, opts: { secret: string; baseURL: string }) {
  return betterAuth({
    database: drizzleAdapter(authDb, { provider: "pg" }),
    emailAndPassword: {
      enabled: true,
      // No verification email until Phase 12's real signup flow (Phase 11 ships digest-send infra
      // only — locked at Phase-11 planning); flips true when sendVerificationEmail is wired there.
      requireEmailVerification: false,
      // Headless CLI seeds: don't mint a throwaway `session` row + cookies on every create. The
      // service flips emailVerified=true directly (signUpEmail hardcodes false; no admin session here).
      autoSignIn: false,
    },
    secret: opts.secret,
    baseURL: opts.baseURL,
    // Literal "uuid" (NOT a generateId function): only the literal makes the Better Auth CLI emit
    // `uuid()` id/FK DDL, which FKs cleanly against our existing `uuid` user_id columns (decision B2).
    advanced: { database: { generateId: "uuid" } },
  });
}

/** The constructed Better Auth instance (handler + server `api`). */
export type Auth = ReturnType<typeof createAuth>;
