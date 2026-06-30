import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { createAuthDb } from "@opusfinder/db/auth-client";
import { getDatabaseUrl } from "@opusfinder/db/env";

import { getAuthBaseURL, getAuthSecret } from "./env";
import { createAuth } from "./index";

// Phase 0 pilot — the one live-DB `skipIf` gate. Ports scripts/test-auth-db.ts. It proves the seam that
// PGlite CANNOT fake: neon-serverless interactive transactions (auth signUpEmail wrapping). neon-http
// throws "No transactions support"; only a real Neon branch over neon-serverless runs `tx.execute`.
//
// Gated on an EXPLICIT opt-in flag (repo idiom — cf. HN_LIVE_TEST / OUTSCAL_SEED_LIVE) on top of the
// creds, so it SKIPS cleanly on every dev box and in the secret-free CI lane even when a package .env
// happens to define DATABASE_URL. The owner runs it with `AUTH_LIVE_TEST=1` + creds against a Neon branch
// (see VITEST_MIGRATION_PLAN §8). The top-level imports are side-effect-free (lazy env getters), so the
// file loads — and skips — without any creds present.
const LIVE =
  process.env.AUTH_LIVE_TEST === "1" &&
  !!process.env.DATABASE_URL &&
  !!process.env.BETTER_AUTH_SECRET;

describe.skipIf(!LIVE)("auth over neon-serverless (live)", () => {
  let authDb: ReturnType<typeof createAuthDb>;

  afterAll(async () => {
    // A neon-serverless Pool holds the socket open; close it or the process won't exit cleanly.
    await authDb?.$client.end();
  });

  it("constructs createAuth and runs an interactive transaction (neon-serverless is tx-capable)", async () => {
    authDb = createAuthDb(getDatabaseUrl());

    const auth = createAuth(authDb, { secret: getAuthSecret(), baseURL: getAuthBaseURL() });
    expect(typeof auth.handler).toBe("function");

    // A `select 1` inside a transaction is the precise, table-free probe: it throws on neon-http and
    // resolves on neon-serverless.
    const rows = await authDb.transaction(async (tx) => {
      const result = await tx.execute(sql`select 1 as ok`);
      return result.rows;
    });
    expect(rows[0]?.ok).toBe(1);
  });
});
