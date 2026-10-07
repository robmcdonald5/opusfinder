import { WorkerEntrypoint } from "cloudflare:workers";

import type { Role } from "@opusfinder/control";

import { identify, type Caller } from "./auth";
import { AUDIT_NAME_RE } from "./auth-config";
import type { Env } from "./env";
import { MAX_BODY_BYTES } from "./limits";
import { renderError, renderPage } from "./page";
import {
  ApiError,
  approve,
  field,
  gate,
  proposal,
  proposalNote,
  proposals,
  propose,
  recordRun,
  reject,
  requestChange,
  status,
  trip,
  withdraw,
} from "./service";

/**
 * opusfinder-control — the edge control plane (control-surface architecture, candidate B, slice 1).
 *
 * Two ways in, and only two:
 *   1. HTTP (`fetch`): the JSON API under /v1, the owner page at /, and its form posts under /ui. Every
 *      request is identified from a VERIFIED Cloudflare Access token (auth.ts) BEFORE routing, so an
 *      unidentified caller learns nothing — not even which routes exist. Each route then lists the roles
 *      it admits (default deny), and every desired-state change goes through classify().
 *   2. RPC (`ControlRpc`, a WorkerEntrypoint): gate(), recordRun(), trip() for Workers in this account via
 *      a service binding. RPC methods can't be reached over HTTP, and Access never sees binding traffic,
 *      so a binding caller IS the runtime role — the least-privileged role (read gates, write ledger rows,
 *      trip a stage off). A binding's plain `fetch()` lands in (1) without an Access token and is refused.
 *
 * The Worker never holds a Neon credential and imports nothing that could reach Neon (guard:worker
 * enforces an inputs allow-list on this bundle), so reading or flipping a switch can't wake the database
 * (C4).
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
// No script, no framing, forms post only to ourselves; nothing is cached (state changes under it).
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function withHeaders(
  body: string | null,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

function json(body: unknown, status = 200): Response {
  return withHeaders(JSON.stringify(body, null, 2), status, JSON_HEADERS);
}

function html(body: string, status = 200): Response {
  return withHeaders(body, status, { "content-type": "text/html; charset=utf-8" });
}

function redirect(location: string): Response {
  return withHeaders(null, 303, { location });
}

function errorJson(err: ApiError): Response {
  return json({ error: { code: err.code, message: err.message }, ...err.extra }, err.status);
}

const tooLarge = () => new ApiError(413, "too_large", `body over ${MAX_BODY_BYTES} bytes`);

/**
 * Read a body with a hard cap in BYTES (not UTF-16 code units): refuse up front when Content-Length
 * declares more, and count bytes while streaming, so an undeclared or chunked body can't get past it
 * either — nothing over the cap is ever buffered. No body reads as "".
 */
async function readBody(request: Request): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) throw tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * The JSON API's body. Optional (approve/reject/withdraw need none; an empty body reads as {}), but a
 * body that IS sent must be declared application/json — a cross-site HTML form can't send that without a
 * CORS preflight, which this Worker never answers — and must be a JSON object, never null/array/scalar.
 */
async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  // A declared non-JSON type is refused even with no body: every HTML form declares one, so this keeps
  // form-shaped requests out on top of the cross-site check.
  const type = request.headers.get("content-type");
  if (type !== null && !type.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "send the body as application/json");
  }
  const text = await readBody(request);
  if (text.length === 0) return {};
  if (type === null) {
    throw new ApiError(415, "unsupported_media_type", "send the body as application/json");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, "invalid_body", "body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * CSRF guard for every state-changing request. Browsers mark a cross-site request (Origin, and
 * Sec-Fetch-Site); the CLI and runtimes send neither. Body-less POSTs (approve/reject/withdraw) have no
 * content type to check, so THIS — not the JSON rule — is what stops another site from driving them with
 * the owner's Access cookie.
 */
function assertNotCrossSite(request: Request, url: URL): void {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (
    (origin !== null && origin !== url.origin) ||
    (site !== null && site !== "same-origin" && site !== "none")
  ) {
    throw new ApiError(403, "cross_origin", "cross-site requests can't change anything here");
  }
}

/** The page's forms: same-origin only (CSRF). Browsers always send Origin on a form POST. */
async function formBody(request: Request, url: URL): Promise<URLSearchParams> {
  if (request.headers.get("origin") !== url.origin) {
    throw new ApiError(403, "cross_origin", "form posts must come from this page");
  }
  return new URLSearchParams(await readBody(request));
}

function proposalId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new ApiError(400, "invalid_id", "bad proposal id");
  return id;
}

/** The CLI marks its requests so the change log can say "via cli"; it is audit metadata, never authority. */
function apiChannel(request: Request): "api" | "cli" {
  return request.headers.get("x-opusfinder-client") === "ctl" ? "cli" : "api";
}

interface RouteCtx {
  request: Request;
  env: Env;
  url: URL;
  caller: Caller;
  params: string[];
  now: string;
}

interface Route {
  method: "GET" | "POST";
  pattern: RegExp;
  /** Who may call it. Anything not listed is refused (403) before the handler runs. */
  roles: readonly Role[];
  /** HTML error pages instead of JSON. */
  ui?: true;
  handler: (ctx: RouteCtx) => Promise<Response>;
}

const OWNER_AGENT: readonly Role[] = ["owner", "agent"];

const ROUTES: readonly Route[] = [
  {
    method: "GET",
    pattern: /^\/$/,
    roles: OWNER_AGENT,
    ui: true,
    handler: async ({ env, caller, url, now }) =>
      html(renderPage(await status(env.DB, caller, now), url.searchParams.get("done"))),
  },
  {
    method: "POST",
    pattern: /^\/ui\/change$/,
    roles: ["owner"],
    ui: true,
    handler: async ({ request, env, caller, url, now }) => {
      const form = await formBody(request, url);
      const body = {
        target: form.get("target"),
        value: form.get("value"),
        reason: form.get("reason"),
      };
      const res = await requestChange(env.DB, caller, body, "panel", now);
      return redirect(`/?done=${res.result === "noop" ? "noop" : "applied"}`);
    },
  },
  {
    method: "POST",
    pattern: /^\/ui\/proposals\/(\d+)\/(approve|reject)$/,
    roles: ["owner"],
    ui: true,
    handler: async ({ request, env, caller, url, params, now }) => {
      const form = await formBody(request, url);
      const id = proposalId(params[0] ?? "");
      const note = proposalNote(form.get("note"));
      if (params[1] === "reject") {
        await reject(env.DB, caller, id, note, now);
        return redirect("/?done=rejected");
      }
      try {
        await approve(env.DB, caller, id, note, "panel", now);
      } catch (err) {
        // Not an error from the owner's point of view: the page says the proposal went stale and why
        // (it is now listed under recently closed), nothing was applied.
        if (err instanceof ApiError && err.code === "stale_proposal")
          return redirect("/?done=stale");
        throw err;
      }
      return redirect("/?done=approved");
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/status$/,
    roles: OWNER_AGENT,
    handler: async ({ env, caller, now }) => json(await status(env.DB, caller, now)),
  },
  {
    method: "GET",
    pattern: /^\/v1\/gate\/([a-z0-9_.]+)$/,
    roles: ["owner", "agent", "runtime"],
    handler: async ({ env, url, params }) =>
      json(await gate(env.DB, params[0] ?? "", Object.fromEntries(url.searchParams))),
  },
  {
    method: "POST",
    pattern: /^\/v1\/changes$/,
    roles: OWNER_AGENT,
    handler: async ({ request, env, caller, now }) => {
      const res = await requestChange(
        env.DB,
        caller,
        await jsonBody(request),
        apiChannel(request),
        now,
      );
      return json(res, res.result === "proposed" ? 202 : 200);
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/proposals$/,
    roles: OWNER_AGENT,
    handler: async ({ env, url, now }) =>
      json({ proposals: await proposals(env.DB, url.searchParams.get("status"), now) }),
  },
  {
    method: "POST",
    pattern: /^\/v1\/proposals$/,
    roles: OWNER_AGENT,
    handler: async ({ request, env, caller, now }) => {
      const res = await propose(env.DB, caller, await jsonBody(request), now);
      return json(res, res.duplicate ? 200 : 201);
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/proposals\/(\d+)$/,
    roles: OWNER_AGENT,
    handler: async ({ env, params, now }) =>
      json({ proposal: await proposal(env.DB, proposalId(params[0] ?? ""), now) }),
  },
  {
    method: "POST",
    pattern: /^\/v1\/proposals\/(\d+)\/approve$/,
    roles: ["owner"],
    handler: async ({ request, env, caller, params, now }) => {
      const note = proposalNote(field(await jsonBody(request), "note"));
      return json(
        await approve(env.DB, caller, proposalId(params[0] ?? ""), note, apiChannel(request), now),
      );
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/proposals\/(\d+)\/reject$/,
    roles: ["owner"],
    handler: async ({ request, env, caller, params, now }) => {
      const note = proposalNote(field(await jsonBody(request), "note"));
      return json({
        proposal: await reject(env.DB, caller, proposalId(params[0] ?? ""), note, now),
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/proposals\/(\d+)\/withdraw$/,
    roles: OWNER_AGENT,
    handler: async ({ request, env, caller, params, now }) => {
      await jsonBody(request);
      return json({ proposal: await withdraw(env.DB, caller, proposalId(params[0] ?? ""), now) });
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/runs$/,
    roles: ["runtime"],
    handler: async ({ request, env, caller, now }) =>
      json(await recordRun(env.DB, caller, await jsonBody(request), now), 201),
  },
  {
    method: "POST",
    pattern: /^\/v1\/trip$/,
    roles: ["runtime"],
    handler: async ({ request, env, caller, now }) =>
      json(await trip(env.DB, caller, await jsonBody(request), apiChannel(request), now)),
  },
];

function fail(err: ApiError, ui: boolean): Response {
  return ui ? html(renderError(err.status, err.code, err.message), err.status) : errorJson(err);
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const ui = !url.pathname.startsWith("/v1/");

  // 1. Who is calling? Before routing — default deny for everything, including 404s.
  const auth = await identify(request, env);
  if (!auth.ok) return fail(new ApiError(auth.status, auth.code, auth.message), ui);

  // 2. Which route? Path match first so a wrong method is a 405, not a 404.
  const matches = ROUTES.map((r) => ({ r, m: r.pattern.exec(url.pathname) })).filter((x) => x.m);
  if (matches.length === 0)
    return fail(new ApiError(404, "not_found", `no route ${url.pathname}`), ui);
  const hit = matches.find((x) => x.r.method === request.method);
  if (!hit || !hit.m)
    return fail(new ApiError(405, "method_not_allowed", `${request.method} not allowed here`), ui);
  const route = hit.r;

  // 3. May this role call it?
  if (!route.roles.includes(auth.caller.role)) {
    return fail(
      new ApiError(
        403,
        "forbidden",
        `the ${auth.caller.role} role can't call ${request.method} ${url.pathname}`,
      ),
      ui,
    );
  }

  try {
    if (request.method !== "GET") assertNotCrossSite(request, url);
    return await route.handler({
      request,
      env,
      url,
      caller: auth.caller,
      params: hit.m.slice(1),
      now: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof ApiError) return fail(err, route.ui === true);
    // Name + first line only: a D1 error message can quote SQL; nothing from the request is echoed back.
    const detail =
      err instanceof Error
        ? `${err.name}: ${(err.message.split("\n")[0] ?? "").slice(0, 200)}`
        : "unknown";
    console.error(`${request.method} ${url.pathname} failed: ${detail}`);
    return fail(
      new ApiError(500, "internal", "internal error (see Worker logs)"),
      route.ui === true,
    );
  }
}

export default {
  fetch: (request, env) => handle(request, env),
} satisfies ExportedHandler<Env>;

/** Props a service binding may attach (wrangler `services = [{ …, props = { name = "…" } }]`). The name is
 *  only an audit label; the role is always "runtime". */
interface BindingProps {
  name?: unknown;
}

/**
 * The runtime RPC surface for Workers in this account (the scrapers Worker, via a service binding, in a
 * later slice). Same rules as the HTTP routes with role "runtime": read a gate, write a ledger row, trip a
 * stage off. Errors surface to the caller as thrown exceptions; a caller that can't reach this — or gets
 * an error from gate() — must SKIP its tick (fail-closed layer 3, `onUnreadable: "skip"`).
 */
export class ControlRpc extends WorkerEntrypoint<Env, BindingProps> {
  private caller(): Caller {
    const name = this.ctx.props?.name;
    return {
      role: "runtime",
      name: typeof name === "string" && AUDIT_NAME_RE.test(name) ? name : "service-binding",
    };
  }

  async gate(stage: string, dims?: Record<string, string>) {
    return gate(this.env.DB, stage, dims ?? {});
  }

  async recordRun(run: unknown) {
    return recordRun(this.env.DB, this.caller(), run, new Date().toISOString());
  }

  async trip(stage: string, reason: string, detail?: string) {
    return trip(
      this.env.DB,
      this.caller(),
      { stage, reason, detail },
      "rpc",
      new Date().toISOString(),
    );
  }
}
