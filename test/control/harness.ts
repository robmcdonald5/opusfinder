import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { stages } from "@opusfinder/control";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

/**
 * Test harness for the control Worker (apps/control): the REAL Worker bundle, running in workerd under
 * Miniflare, against a REAL local D1 (SQLite in workerd) with the repo's own migrations applied.
 *
 * Identity is exercised end to end with NO test seam in the Worker: tests mint RS256 Access-style JWTs with
 * a throwaway keypair, and Miniflare's `outboundService` answers the Worker's JWKS fetch to
 * `<team>.cloudflareaccess.com/cdn-cgi/access/certs` with that keypair's public JWK. The Worker runs the
 * exact production verification code; only the network is faked. (This also keeps the suite egress-free,
 * which the `integration` project requires.)
 *
 * A second in-process Worker ("caller") holds service bindings to the control Worker — to its
 * `ControlRpc` entrypoint (with and without binding props) and to its default `fetch` — so the RPC
 * surface and the "a binding's plain fetch carries no Access identity" rule are tested over real bindings.
 */

const APP_DIR = fileURLToPath(new URL("../../apps/control/", import.meta.url));

export const TEAM_DOMAIN = "https://opusfinder-test.cloudflareaccess.com";
export const AUD = "test-aud-0123456789abcdef";
export const OWNER_EMAIL = "owner@example.com";
export const AGENT_CLIENT_ID = "agent-client.access";
export const AGENT_NAME = "observer";
export const OTHER_AGENT_CLIENT_ID = "other-agent-client.access";
export const RUNTIME_CLIENT_ID = "runtime-client.access";
export const RUNTIME_NAME = "cf:opusfinder-scrapers";
export const OTHER_RUNTIME_CLIENT_ID = "other-runtime-client.access";
export const ORIGIN = "https://control.test";

export const BILLING_ADDRESS = "billing@control.test";

export const DEFAULT_BINDINGS: Record<string, string> = {
  BILLING_ADDRESS,
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD: AUD,
  OWNER_EMAILS: ` ${OWNER_EMAIL.toUpperCase()} , second-owner@example.com`,
  SERVICE_TOKENS: JSON.stringify({
    [AGENT_CLIENT_ID]: { role: "agent", name: AGENT_NAME },
    [OTHER_AGENT_CLIENT_ID]: { role: "agent", name: "other-agent" },
    [RUNTIME_CLIENT_ID]: { role: "runtime", name: RUNTIME_NAME },
    [OTHER_RUNTIME_CLIENT_ID]: { role: "runtime", name: "inngest:opusfinder" },
  }),
};

/** The compatibility date the deployed Worker uses — one source of truth (wrangler.toml). */
export function compatibilityDate(): string {
  const toml = readFileSync(join(APP_DIR, "wrangler.toml"), "utf8");
  const m = /^compatibility_date\s*=\s*"([^"]+)"/m.exec(toml);
  if (!m?.[1]) throw new Error("compatibility_date not found in apps/control/wrangler.toml");
  return m[1];
}

/** Bundle the Worker exactly as the guard does (edge conditions, `cloudflare:workers` from the runtime). */
export async function bundleWorker(): Promise<string> {
  const result = await build({
    entryPoints: [join(APP_DIR, "src/index.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers"],
    logLevel: "silent",
  });
  const out = result.outputFiles[0];
  if (!out) throw new Error("esbuild produced no output");
  return out.text;
}

/**
 * The migrations in apply order, split into statements. The migration files keep one statement per
 * `;`-terminated line-end and no triggers, so dropping `--` comment lines and splitting there is exact.
 */
export function migrationStatements(): string[] {
  const dir = join(APP_DIR, "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) =>
      readFileSync(join(dir, f), "utf8")
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .split(/;\s*(?:\n|$)/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
}

/**
 * A test-only Worker that exposes the store's applyChange() directly, so the compare-and-set guard can be
 * driven with a deliberately STALE expected value — the read-classify-write race the guard exists for,
 * which can't be reproduced through the API. Bundled from a JS stub (no type check needed) against the
 * real store module; it never ships (the deployed bundle's entry is src/index.ts).
 */
export async function bundleStoreProbe(): Promise<string> {
  const result = await build({
    stdin: {
      contents: `import { applyChange } from "./store.ts";
export default {
  async fetch(request, env) {
    return Response.json(await applyChange(env.DB, await request.json()));
  },
};`,
      resolveDir: join(APP_DIR, "src"),
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    logLevel: "silent",
  });
  const out = result.outputFiles[0];
  if (!out) throw new Error("esbuild produced no probe output");
  return out.text;
}

// ---------------------------------------------------------------- Access-style JWTs

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return Buffer.from(bytes).toString("base64url");
}

export interface SignOptions {
  kid?: string;
  alg?: string;
  /** Sign with a different private key than the one the JWKS publishes. */
  key?: CryptoKey;
}

export class AccessKeys {
  private constructor(
    readonly kid: string,
    private readonly privateKey: CryptoKey,
    readonly publicJwk: JsonWebKey,
  ) {}

  static async create(kid = "test-kid-1"): Promise<AccessKeys> {
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    return new AccessKeys(kid, pair.privateKey, jwk);
  }

  /** The body Access serves at /cdn-cgi/access/certs (JWK form; PEMs omitted — the Worker reads `keys`). */
  jwks(): { keys: JsonWebKey[] } {
    return { keys: [{ ...this.publicJwk, kid: this.kid, alg: "RS256", use: "sig" } as JsonWebKey] };
  }

  async sign(claims: Record<string, unknown>, opts: SignOptions = {}): Promise<string> {
    const header = b64url(
      JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? this.kid, typ: "JWT" }),
    );
    const payload = b64url(JSON.stringify(claims));
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      opts.key ?? this.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
  }

  /** The claims of a human (identity-provider) application token. */
  static humanClaims(email: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      aud: [AUD],
      email,
      exp: now + 600,
      iat: now,
      nbf: now,
      iss: TEAM_DOMAIN,
      type: "app",
      identity_nonce: "nonce",
      sub: "7335d417-61da-459d-899c-0a01c76a2f94",
      country: "US",
      ...extra,
    };
  }

  /** The claims of a service-token application token (common_name = client id, empty sub). */
  static serviceClaims(
    clientId: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      type: "app",
      aud: [AUD],
      exp: now + 600,
      iss: TEAM_DOMAIN,
      common_name: clientId,
      iat: now,
      sub: "",
      ...extra,
    };
  }
}

// ---------------------------------------------------------------- Miniflare

/**
 * A stand-in for the Workers AI binding (the real one only runs on Cloudflare). The control Worker reaches it
 * as env.AI over a service binding (JS RPC). A test scripts the model's answer by putting "FAKE_AI <json>"
 * on one line of the email: that JSON comes back as the model's response; without it, the answer is "not a
 * bill". "FAKE_AI_FAIL" makes the call throw, like a transport error.
 */
const FAKE_AI_SCRIPT = `
import { WorkerEntrypoint } from "cloudflare:workers";
export class FakeAi extends WorkerEntrypoint {
  async run(model, inputs) {
    const text = inputs.messages.map((m) => m.content).join("\\n");
    if (text.includes("FAKE_AI_FAIL")) throw new Error("AI unavailable (fake)");
    const m = /FAKE_AI (\\{.*\\})/.exec(text);
    return { response: m ? JSON.parse(m[1]) : { is_bill: false, vendor: "", kind: "other", total: "",
      currency: "", charged_on: "", period_start: "", reference: "" } };
  }
  async toMarkdown() {
    return [{ format: "error", error: "not supported in tests" }];
  }
}
export default { fetch: () => new Response("fake ai") };
`;

const CALLER_SCRIPT = `
export default {
  async fetch(request, env) {
    const { binding, method, args, path } = await request.json();
    try {
      if (method === "fetch") {
        const res = await env[binding].fetch("https://control.internal" + path);
        return Response.json({ status: res.status, body: await res.text() });
      }
      return Response.json({ ok: true, value: await env[binding][method](...args) });
    } catch (err) {
      return Response.json({ ok: false, error: String(err && err.message || err) });
    }
  },
};`;

export type Who =
  | "owner"
  | "agent"
  | "other-agent"
  | "runtime"
  | "other-runtime"
  | { token: string }
  | null;

export interface RequestOptions {
  as: Who;
  method?: string;
  json?: unknown;
  form?: Record<string, string>;
  /** A raw body, sent as-is (for malformed-input tests). */
  body?: string;
  headers?: Record<string, string>;
}

/** Miniflare's node-side proxy of the Worker's D1 binding (real local D1, driven from the test). */
export type TestD1 = Awaited<ReturnType<Miniflare["getD1Database"]>>;

export interface ControlHarness {
  mf: Miniflare;
  keys: AccessKeys;
  db: TestD1;
  /** How many times the Worker fetched the JWKS. */
  jwksFetches: () => number;
  /** Make the faked Access key endpoint answer 503 (true) or the keys again (false). */
  setJwksFailing: (failing: boolean) => void;
  token: (who: Exclude<Who, null | { token: string }>) => Promise<string>;
  request: (path: string, opts: RequestOptions) => Promise<Response>;
  /** Call the ControlRpc entrypoint (or the default fetch) through a real service binding. */
  rpc: (
    binding: "RPC" | "RPC_ANON",
    method: string,
    ...args: unknown[]
  ) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
  bindingFetch: (path: string) => Promise<{ status: number; body: string }>;
  /** Call store.applyChange() directly (same D1) — see bundleStoreProbe(). */
  applyChange: (input: Record<string, unknown>) => Promise<{ applied: boolean; changeId?: number }>;
  /** Deliver a raw RFC 5322 email to the Worker's email() handler (Miniflare's local trigger). */
  email: (raw: string, envelope?: { from?: string; to?: string }) => Promise<Response>;
  /** Drop every table and re-apply the migrations: a fresh, seeded store. */
  reset: () => Promise<void>;
  dispose: () => Promise<void>;
}

export async function startControl(
  bindings: Record<string, string | undefined> = DEFAULT_BINDINGS,
): Promise<ControlHarness> {
  const keys = await AccessKeys.create();
  const code = await bundleWorker();
  const probe = await bundleStoreProbe();
  const date = compatibilityDate();
  let jwksFetches = 0;
  let jwksFailing = false;
  const definedBindings = Object.fromEntries(
    Object.entries(bindings).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;

  const mf = new Miniflare({
    // Enables POST /cdn-cgi/handler/email?from=…&to=… (Miniflare's local trigger for the email() handler),
    // answered by Miniflare itself before the Worker's fetch (and so before Access): tests only.
    unsafeTriggerHandlers: true,
    workers: [
      {
        name: "control",
        modules: [{ type: "ESModule", path: "index.js", contents: code }],
        compatibilityDate: date,
        d1Databases: { DB: "opusfinder-control-test" },
        bindings: definedBindings,
        serviceBindings: { AI: { name: "fake-ai", entrypoint: "FakeAi" } },
        outboundService: (request: Request) => {
          if (request.url === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
            jwksFetches++;
            if (jwksFailing) return new Response("upstream unavailable", { status: 503 });
            return new Response(JSON.stringify(keys.jwks()), {
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(`unexpected outbound fetch in test: ${request.url}`, { status: 599 });
        },
      },
      {
        name: "caller",
        modules: true,
        script: CALLER_SCRIPT,
        compatibilityDate: date,
        serviceBindings: {
          RPC: {
            name: "control",
            entrypoint: "ControlRpc",
            props: { name: stages.ingest.runtime }, // as the scrapers Worker's wrangler.toml sets it
          },
          RPC_ANON: { name: "control", entrypoint: "ControlRpc" },
          PLAIN: "control",
        },
      },
      {
        name: "fake-ai",
        modules: true,
        script: FAKE_AI_SCRIPT,
        compatibilityDate: date,
      },
      {
        name: "store-probe",
        modules: [{ type: "ESModule", path: "probe.js", contents: probe }],
        compatibilityDate: date,
        // Same database id as the control Worker → the same local D1.
        d1Databases: { DB: "opusfinder-control-test" },
      },
    ],
  });
  const db = await mf.getD1Database("DB", "control");

  const harness: ControlHarness = {
    mf,
    keys,
    db,
    jwksFetches: () => jwksFetches,
    setJwksFailing: (failing) => {
      jwksFailing = failing;
    },
    async token(who) {
      switch (who) {
        case "owner":
          return keys.sign(AccessKeys.humanClaims(OWNER_EMAIL));
        case "agent":
          return keys.sign(AccessKeys.serviceClaims(AGENT_CLIENT_ID));
        case "other-agent":
          return keys.sign(AccessKeys.serviceClaims(OTHER_AGENT_CLIENT_ID));
        case "runtime":
          return keys.sign(AccessKeys.serviceClaims(RUNTIME_CLIENT_ID));
        case "other-runtime":
          return keys.sign(AccessKeys.serviceClaims(OTHER_RUNTIME_CLIENT_ID));
      }
    },
    async request(path, opts) {
      const headers: Record<string, string> = { ...opts.headers };
      if (opts.as !== null) {
        headers["cf-access-jwt-assertion"] =
          typeof opts.as === "object" ? opts.as.token : await harness.token(opts.as);
      }
      let body: string | undefined = opts.body;
      if (opts.json !== undefined) {
        headers["content-type"] ??= "application/json";
        body = JSON.stringify(opts.json);
      } else if (opts.form) {
        headers["content-type"] ??= "application/x-www-form-urlencoded";
        headers.origin ??= ORIGIN;
        body = new URLSearchParams(opts.form).toString();
      }
      // An explicitly empty header means "send none" (e.g. a form post with no Origin at all).
      for (const [k, v] of Object.entries(headers)) if (v === "") delete headers[k];
      const res = await mf.dispatchFetch(`${ORIGIN}${path}`, {
        method: opts.method ?? (body === undefined ? "GET" : "POST"),
        headers,
        body,
        redirect: "manual",
      });
      return res as unknown as Response;
    },
    async rpc(binding, method, ...args) {
      const caller = await mf.getWorker("caller");
      const res = await caller.fetch("https://caller.internal/", {
        method: "POST",
        body: JSON.stringify({ binding, method, args }),
      });
      return (await res.json()) as { ok: boolean; value?: unknown; error?: string };
    },
    async bindingFetch(path) {
      const caller = await mf.getWorker("caller");
      const res = await caller.fetch("https://caller.internal/", {
        method: "POST",
        body: JSON.stringify({ binding: "PLAIN", method: "fetch", path }),
      });
      return (await res.json()) as { status: number; body: string };
    },
    async applyChange(input) {
      const worker = await mf.getWorker("store-probe");
      const res = await worker.fetch("https://probe.internal/", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return (await res.json()) as { applied: boolean; changeId?: number };
    },
    async email(raw, envelope = {}) {
      const url = new URL("http://localhost/cdn-cgi/handler/email");
      url.searchParams.set("from", envelope.from ?? "owner@example.com");
      url.searchParams.set("to", envelope.to ?? BILLING_ADDRESS);
      const res = await mf.dispatchFetch(url, { method: "POST", body: raw });
      return res as unknown as Response;
    },
    async reset() {
      // Every table the migrations made, so a new one replays too. D1 enforces foreign keys, so defer
      // them: this order can drop a parent (proposal) before the child that references it (change_log).
      const { results } = await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'",
        )
        .all<{ name: string }>();
      await db.batch([
        db.prepare("PRAGMA defer_foreign_keys = on"),
        ...results.map(({ name }) => db.prepare(`DROP TABLE "${name}"`)),
      ]);
      await db.batch(migrationStatements().map((s) => db.prepare(s)));
    },
    dispose: () => mf.dispose(),
  };
  await harness.reset();
  return harness;
}
