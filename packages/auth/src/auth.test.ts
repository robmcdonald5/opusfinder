import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AuthDb } from "@opusfinder/db/auth-client";

import { createAuth, type Auth } from "./auth";

// Creds-free unit pin of the Better Auth construction (always-on counterpart to the AUTH_LIVE_TEST
// gate in auth.integration.test.ts, which skips everywhere except the owner's manual live run).
//
// Deliberately does NOT import ./env: that module runs loadPackageEnv at import, which would load
// the dev box's real packages/auth/.env into process.env and break hermeticity. Everything here is
// injected as literal fakes through createAuth's DI seam.
//
// better-auth 1.6.14 starts its async init EAGERLY at construction (dist/auth/base.mjs assigns
// `initFn(options)` before returning), so ONE shared instance is constructed in beforeAll and its
// $context promise is settled by the adapter test below — a rejection would otherwise surface as
// unhandled-rejection noise instead of a test failure.

// ≥32 chars each so better-auth's secret-length warning can never fire; DIFFERENT values so a
// dropped opts.secret passthrough (falling back to env) is visible, not masked.
const INJECTED_SECRET = "unit-injected-secret-0123456789-abcdefghijklmnop";
const ENV_DECOY_SECRET = "env-decoy-secret-9876543210-ponmlkjihgfedcba-zyx";
const INJECTED_BASE_URL = "http://auth-unit-test.local:5173";

let auth: Auth;

beforeAll(() => {
  // Telemetry is opt-in (and skipped under test), but the unit project has no MSW net-guard —
  // pin it off so construction can never attempt network.
  vi.stubEnv("BETTER_AUTH_TELEMETRY", "0");
  // better-auth's context creation falls back to env.BETTER_AUTH_SECRET when options.secret is
  // absent — stub a DIFFERENT valid secret so injection winning is observable.
  vi.stubEnv("BETTER_AUTH_SECRET", ENV_DECOY_SECRET);

  // A bare property-free stub: construction (and $context resolution) must never touch the db.
  auth = createAuth({} as unknown as AuthDb, {
    secret: INJECTED_SECRET,
    baseURL: INJECTED_BASE_URL,
  });
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("createAuth — wiring config (creds-free)", () => {
  it("constructs against a bare stub db: handler and api.signUpEmail are functions — no db access at construction", () => {
    // The beforeAll construction succeeding with `{}` IS the no-db-access proof (drizzle schema
    // lookup is lazy per operation). These pin the two surfaces callers actually use: the HTTP
    // handler and the exact endpoint service.ts calls.
    expect(typeof auth.handler).toBe("function");
    expect(typeof auth.api.signUpEmail).toBe("function");
  });

  it('pins generateId as the literal string "uuid", never a function — the Better Auth CLI uuid-DDL/FK contract', () => {
    const generateId = auth.options.advanced?.database?.generateId;
    // Only the LITERAL makes the Better Auth CLI emit uuid() id/FK DDL that FKs cleanly against
    // our existing uuid user_id columns; a generateId FUNCTION would type ids as text.
    expect(typeof generateId).toBe("string");
    expect(generateId).toBe("uuid");
  });

  it("pins the emailAndPassword posture: enabled true, requireEmailVerification false, autoSignIn false", () => {
    expect(auth.options.emailAndPassword?.enabled).toBe(true);
    // Flips true only when sendVerificationEmail is wired.
    expect(auth.options.emailAndPassword?.requireEmailVerification).toBe(false);
    // Headless CLI seeds must not mint throwaway session rows/cookies.
    expect(auth.options.emailAndPassword?.autoSignIn).toBe(false);
  });

  it("passes the injected secret through verbatim — a DIFFERENT stubbed BETTER_AUTH_SECRET env value does not win", () => {
    // Fixture sanity: the decoy must differ or a dropped passthrough would be invisible.
    expect(ENV_DECOY_SECRET).not.toBe(INJECTED_SECRET);
    // The stub was live at construction time and still is — the env fallback path was reachable.
    expect(process.env.BETTER_AUTH_SECRET).toBe(ENV_DECOY_SECRET);
    expect(auth.options.secret).toBe(INJECTED_SECRET);
  });

  it("passes the injected baseURL through verbatim", () => {
    expect(auth.options.baseURL).toBe(INJECTED_BASE_URL);
  });

  it('resolves $context connection-free with the drizzle adapter bound (adapter.id === "drizzle") — settles the eagerly-started init promise', async () => {
    const ctx = await auth.$context;
    expect(ctx.adapter.id).toBe("drizzle");
    // provider "pg" drives supportsUUIDs/pg-native SQL inside the adapter but is invisible via
    // adapter.id (the constant "drizzle" for every provider). The adapter factory spreads the user
    // config onto adapter.options, so the pin is observable creds-free (cast: the core DBAdapter
    // type does not declare the passthrough keys).
    const opts = ctx.adapter.options as {
      provider?: string;
      adapterConfig?: { supportsUUIDs?: boolean };
    };
    expect(opts.provider).toBe("pg");
    expect(opts.adapterConfig?.supportsUUIDs).toBe(true);
  });
});
