import type { Role } from "@opusfinder/control";

import { authConfig, type AuthConfig } from "./auth-config";
import type { Env } from "./env";
import { KeyCache, KeysUnavailableError } from "./key-cache";

/**
 * Caller identity = role (§11.1: the credential IS the role). Every HTTP request is identified ONLY from a
 * cryptographically verified Cloudflare Access application token — the `Cf-Access-Jwt-Assertion` header
 * Access attaches to every request it lets through — checked here against the team's JWKS, issuer and the
 * application's AUD tag. There is no other path in: no header trust, no cookie trust, no dev bypass.
 *
 * Why verify the JWT ourselves rather than read `ctx.access` (the 2026 "Protect this Worker behind
 * Access" identity object):
 *   - service tokens are first-class here (agent + runtime roles), and the token's `common_name` (the
 *     service-token client id) is documented on the JWT; what `ctx.access.getIdentity()` returns for a
 *     service token is not documented;
 *   - wrangler's `[access.dev]` block SIMULATES `ctx.access` locally — exactly the kind of local identity
 *     shortcut this Worker must not have. Ignoring `ctx.access` means that block can never grant anything;
 *   - it is defence in depth: if Access were ever detached from this Worker (or a new route skipped it),
 *     a request without a token signed by Access's private key for OUR AUD still gets nothing.
 *
 * Default deny everywhere: missing config → 503 for every request; no/invalid token → 401; a valid token
 * whose human email isn't in OWNER_EMAILS, or whose service-token client id isn't in SERVICE_TOKENS → 403.
 * The runtime role is ALSO reachable through the RPC entrypoint (a service binding — Access never sees
 * those calls), which can't be called from the public internet at all; see index.ts.
 */
export interface Caller {
  role: Role;
  /** Audit name: the owner's email, the service token's configured name, or the binding's label. */
  name: string;
}

export type AuthResult =
  | { ok: true; caller: Caller }
  | { ok: false; status: 401 | 403 | 503; code: string; message: string };

const CLOCK_SKEW_S = 60;
const MAX_TOKEN_LENGTH = 8192;

// ---- JWKS (Access signing keys rotate every ~6 weeks; the old key stays valid 7 days) ----

async function fetchJwks(domain: string): Promise<Map<string, CryptoKey>> {
  const res = await fetch(`${domain}/cdn-cgi/access/certs`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Access JWKS fetch failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { keys?: unknown };
  const keys = new Map<string, CryptoKey>();
  for (const k of Array.isArray(body.keys) ? body.keys : []) {
    const jwk = k as { kid?: unknown; kty?: unknown; n?: unknown; e?: unknown };
    if (typeof jwk.kid !== "string" || jwk.kty !== "RSA") continue;
    if (typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }
  return keys;
}

/** One cache per team domain per isolate (the policy — TTL, stale-while-error, backoff — is key-cache.ts). */
const keyCaches = new Map<string, KeyCache<CryptoKey>>();

function signingKey(domain: string, kid: string): Promise<CryptoKey | null> {
  let cache = keyCaches.get(domain);
  if (!cache) {
    cache = new KeyCache({ load: () => fetchJwks(domain) });
    keyCaches.set(domain, cache);
  }
  return cache.get(kid);
}

function b64urlBytes(segment: string): Uint8Array {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(b64urlBytes(segment)));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

type Verified = { ok: true; claims: Record<string, unknown> } | { ok: false; reason: string };

/** Verify an Access application token: RS256 signature by a current team key, iss, aud, exp/nbf, type. */
async function verifyAccessJwt(token: string, cfg: AuthConfig): Promise<Verified> {
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "token too large" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const [h, p, s] = parts as [string, string, string];
  const header = b64urlJson(h);
  const claims = b64urlJson(p);
  if (!header || !claims) return { ok: false, reason: "malformed token" };
  // Only RS256 — never "none", never an HMAC alg keyed with a public key.
  if (header.alg !== "RS256") return { ok: false, reason: "unsupported algorithm" };
  if (typeof header.kid !== "string") return { ok: false, reason: "missing key id" };

  const key = await signingKey(cfg.teamDomain, header.kid);
  if (!key) return { ok: false, reason: "unknown signing key" };
  let signature: Uint8Array;
  try {
    signature = b64urlBytes(s);
  } catch {
    return { ok: false, reason: "malformed token" };
  }
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) return { ok: false, reason: "bad signature" };

  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== cfg.teamDomain) return { ok: false, reason: "wrong issuer" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.aud)) return { ok: false, reason: "wrong audience" };
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S <= now) {
    return { ok: false, reason: "expired" };
  }
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > now) {
    return { ok: false, reason: "not yet valid" };
  }
  // "app" = an application token; an "org" (global session) token is not issued for this app.
  if (claims.type !== "app") return { ok: false, reason: "not an application token" };
  return { ok: true, claims };
}

/** Identify an HTTP caller. Default deny: anything not positively recognised is refused. */
export async function identify(request: Request, env: Env): Promise<AuthResult> {
  const cfg = authConfig(env);
  if (!cfg) {
    return {
      ok: false,
      status: 503,
      code: "auth_not_configured",
      message: "ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set (see apps/control/README.md)",
    };
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    return {
      ok: false,
      status: 401,
      code: "unauthenticated",
      message: "no Cloudflare Access identity on this request",
    };
  }
  let verified: Verified;
  try {
    verified = await verifyAccessJwt(token, cfg);
  } catch (err) {
    // The key cache already logged the failed fetch (once per attempt, not per request while it backs
    // off); anything else is unexpected and worth a line.
    if (!(err instanceof KeysUnavailableError)) {
      console.error(
        `identity check unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {
      ok: false,
      status: 503,
      code: "auth_unavailable",
      message: "could not load the Access signing keys; try again shortly",
    };
  }
  if (!verified.ok) {
    return {
      ok: false,
      status: 401,
      code: "invalid_token",
      message: `Access token rejected: ${verified.reason}`,
    };
  }

  const { claims } = verified;
  const commonName = typeof claims.common_name === "string" ? claims.common_name : "";
  if (commonName) {
    const token = cfg.tokens.get(commonName);
    if (!token) {
      return {
        ok: false,
        status: 403,
        code: "unknown_service_token",
        message: "this service token is not mapped to a role (SERVICE_TOKENS)",
      };
    }
    return { ok: true, caller: { role: token.role, name: token.name } };
  }
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (email && sub) {
    if (cfg.owners.has(email)) return { ok: true, caller: { role: "owner", name: email } };
    return {
      ok: false,
      status: 403,
      code: "not_owner",
      message: "this identity is not on the owner list (OWNER_EMAILS)",
    };
  }
  return {
    ok: false,
    status: 401,
    code: "unrecognised_identity",
    message: "token carries no usable identity",
  };
}
