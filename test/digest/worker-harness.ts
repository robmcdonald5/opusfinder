import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type BuildOptions } from "esbuild";
import { Miniflare } from "miniflare";

/**
 * Test harnesses for the digest Worker (apps/digest), both in workerd under Miniflare with its local
 * Workflows engine:
 *  - {@link startEngineWorker}: a test-only Worker whose Workflow runs a scripted "stage" through the
 *    REAL step adapter (src/steps.ts) and whose fan-out is the REAL `startUserRuns` (src/fan-out.ts), so
 *    the rules that depend on the engine (one run per id, a run that spans ticks, retries, what an errored
 *    instance stores) are checked against it and not a stand-in.
 *  - {@link startDigestWorker}: the REAL Worker bundle, as `wrangler deploy` would upload it, with its
 *    compatibility date and no compatibility flags, a fake control Worker behind its CONTROL binding and
 *    every outbound fetch refused. Its crons are fired through Miniflare's scheduled trigger.
 */

const APP_DIR = fileURLToPath(new URL("../../apps/digest/", import.meta.url));

export function wranglerToml(): string {
  return readFileSync(join(APP_DIR, "wrangler.toml"), "utf8");
}

function compatibilityDate(): string {
  const m = /^compatibility_date\s*=\s*"([^"]+)"/m.exec(wranglerToml());
  if (!m?.[1]) throw new Error("compatibility_date not found in apps/digest/wrangler.toml");
  return m[1];
}

/** How `pnpm guard:worker` and wrangler bundle a Worker: edge conditions, the runtime's own modules left
 *  for the runtime. */
const BUNDLE: BuildOptions = {
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:workers", "cloudflare:workflows"],
  logLevel: "silent",
};

async function bundled(options: BuildOptions): Promise<string> {
  const out = (await build({ ...BUNDLE, ...options })).outputFiles?.[0];
  if (!out) throw new Error("esbuild produced no output");
  return out.text;
}

// ---------------------------------------------------------------- the engine Worker

/** What a scripted run does after its first step. */
export interface RunScript {
  /** Sleep this long (a stage duration, e.g. "2s") before finishing. */
  sleep?: string;
  /** Then fail a step: with the stages' no-retry error, a plain error, or a drizzle-shaped query error. */
  fail?: "no-retry" | "plain" | "query";
}

const ENGINE_ENTRY = `
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { NonRetriableError } from "@opusfinder/digest";
import { startUserRuns } from "./fan-out.ts";
import { STEP_CONFIG, workflowStepTools } from "./steps.ts";

// The production policy with its waits shortened: 4 retries, as STEP_CONFIG has.
const FAST = { ...STEP_CONFIG, retries: { ...STEP_CONFIG.retries, delay: 20, backoff: "constant" } };

const instances = new Map();
const store = {
  last: async (userIds) => new Map(userIds.flatMap((u) => (instances.has(u) ? [[u, instances.get(u)]] : []))),
  record: async (userId, id) => void instances.set(userId, id),
};
const scripts = new Map();
const attempts = {};
const count = (key) => (attempts[key] = (attempts[key] ?? 0) + 1);

export class UserRun extends WorkflowEntrypoint {
  async run(event, step) {
    const { userId } = event.payload;
    const script = scripts.get(userId) ?? {};
    const tools = workflowStepTools(
      { do: (name, config, callback) => step.do(name, config, callback), sleep: (name, ms) => step.sleep(name, ms) },
      (message) => new NonRetryableError(message),
      FAST,
    );
    await tools.run("load", async () => ({ started: count(userId + ":load") }));
    if (script.sleep) await tools.sleep("wait", script.sleep);
    if (script.fail) {
      await tools.run("work", async () => {
        count(userId + ":work");
        if (script.fail === "no-retry") throw new NonRetriableError("digest: a broken invariant");
        if (script.fail === "query") {
          const failed = new Error("Failed query: select 1\\nparams: someone@example.com");
          failed.cause = new Error("canceling statement due to statement timeout");
          throw failed;
        }
        throw new Error("Resend send failed: application_error (500)");
      });
    }
    return { userId };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json() : {};
    try {
      if (url.pathname === "/script") {
        scripts.set(body.userId, body.script);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/fan-out") {
        const events = body.users.map((userId) => ({ name: "digest/user.requested", data: { userId, digestRunId: 1 } }));
        return Response.json({ ok: true, result: await startUserRuns(store, env.USER_RUN, events, body.tick, body.maxUsers ?? 10) });
      }
      if (url.pathname === "/create") {
        await env.USER_RUN.create({ id: body.id, params: { userId: body.userId, digestRunId: 1 } });
        return Response.json({ ok: true });
      }
      if (url.pathname === "/status") {
        return Response.json({ ok: true, status: await (await env.USER_RUN.get(body.id)).status() });
      }
      if (url.pathname === "/attempts") return Response.json({ ok: true, attempts });
    } catch (err) {
      return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return new Response("unknown", { status: 404 });
  },
};
`;

export interface EngineWorker {
  script(userId: string, script: RunScript): Promise<void>;
  /** The real `startUserRuns` for these users on tick `tick`. */
  fanOut(
    users: string[],
    tick: string,
    maxUsers?: number,
  ): Promise<{ started: number; inFlight: number; alreadyStarted: number; overLimit: number }>;
  /** Ask the engine itself to create an instance under `id`. */
  create(id: string, userId: string): Promise<{ ok: boolean; error?: string }>;
  status(id: string): Promise<{ status: string; error?: { name: string; message: string } } | null>;
  /** The instance's status once it is no longer queued, running or waiting. */
  finished(id: string): Promise<{ status: string; error?: { name: string; message: string } }>;
  /** How many times each step body ran, keyed `<userId>:<step>`. */
  attempts(): Promise<Record<string, number>>;
  dispose(): Promise<void>;
}

export async function startEngineWorker(): Promise<EngineWorker> {
  const code = await bundled({
    stdin: { contents: ENGINE_ENTRY, resolveDir: join(APP_DIR, "src"), loader: "js" },
  });
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "index.js", contents: code }],
    compatibilityDate: compatibilityDate(),
    workflows: { USER_RUN: { name: "engine-user-run", className: "UserRun" } },
    outboundService: (request: Request) =>
      new Response(`unexpected outbound fetch in test: ${request.url}`, { status: 599 }),
  });
  await mf.ready;
  const call = async (path: string, body?: unknown) => {
    const res = await mf.dispatchFetch(`https://engine.test${path}`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    });
    return (await res.json()) as { ok: boolean; error?: string } & Record<string, unknown>;
  };
  const status: EngineWorker["status"] = async (id) => {
    const res = await call("/status", { id });
    return res.ok ? (res.status as Awaited<ReturnType<EngineWorker["status"]>>) : null;
  };
  return {
    script: async (userId, script) => void (await call("/script", { userId, script })),
    fanOut: async (users, tick, maxUsers) => {
      const res = await call("/fan-out", { users, tick, maxUsers });
      if (!res.ok) throw new Error(res.error);
      return res.result as Awaited<ReturnType<EngineWorker["fanOut"]>>;
    },
    create: async (id, userId) => {
      const res = await call("/create", { id, userId });
      return { ok: res.ok, error: res.error };
    },
    status,
    finished: async (id) => {
      for (let i = 0; i < 300; i++) {
        const now = await status(id);
        if (now && ["complete", "errored", "terminated"].includes(now.status)) return now;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`instance ${id} did not finish`);
    },
    attempts: async () => (await call("/attempts")).attempts as Record<string, number>,
    dispose: () => mf.dispose(),
  };
}

// ---------------------------------------------------------------- the real Worker

/** A control Worker that answers what the test set and keeps the ledger rows it is sent. */
const FAKE_CONTROL = `
import { WorkerEntrypoint } from "cloudflare:workers";
let gates = {};
let rows = [];
export class ControlRpc extends WorkerEntrypoint {
  async gate(stage) {
    const answer = gates[stage];
    if (answer === undefined) throw new Error("control plane down");
    return answer;
  }
  async recordRun(run) {
    rows.push({ ...run, by: this.ctx.props?.name ?? null });
    return { id: rows.length };
  }
}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/gates") { gates = await request.json(); return new Response("ok"); }
    if (url.pathname === "/rows") { const sent = rows; rows = []; return Response.json(sent); }
    return new Response("unknown", { status: 404 });
  },
};
`;

/** Reads the digest Worker's Workflow instances from outside it, over bindings to the same Workflows. */
const OBSERVER = `
export default {
  async fetch(request, env) {
    const { workflow, id } = await request.json();
    try {
      const instance = await env[workflow].get(id);
      return Response.json({ found: true, status: await instance.status() });
    } catch (err) {
      return Response.json({ found: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
};
`;

export interface DigestWorker {
  /** What the control plane answers per stage; a stage left out is unreadable. */
  setGates(gates: Record<string, unknown>): Promise<void>;
  /** Fire a cron as Cloudflare would. Resolves to whether the handler returned (true) or threw. */
  fire(cron: string, scheduledTime?: number): Promise<boolean>;
  /** The ledger rows the Worker sent since the last call. */
  ledger(): Promise<Record<string, unknown>[]>;
  instance(
    workflow: "DIGEST_RUN" | "DIGEST_USER",
    id: string,
  ): Promise<{ found: boolean; status?: { status: string } }>;
  /** Every URL the Worker tried to fetch. */
  outbound: string[];
  dispose(): Promise<void>;
}

export async function startDigestWorker(): Promise<DigestWorker> {
  const code = await bundled({ entryPoints: [join(APP_DIR, "src/index.ts")] });
  const date = compatibilityDate();
  const outbound: string[] = [];
  const mf = new Miniflare({
    unsafeTriggerHandlers: true,
    workers: [
      {
        name: "digest",
        modules: [{ type: "ESModule", path: "index.js", contents: code }],
        compatibilityDate: date,
        bindings: {
          DATABASE_URL: "postgresql://digest_worker:test@db.neon.test/opusfinder",
          OPENROUTER_API_KEY: "sk-or-test",
          RESEND_API_KEY: "re_send_test",
          RESEND_API_KEY_FULL: "re_full_test",
          EMAIL_FROM: "digest@opusfinder.test",
        },
        serviceBindings: {
          CONTROL: {
            name: "control",
            entrypoint: "ControlRpc",
            props: { name: /props = \{ name = "([^"]+)" \}/.exec(wranglerToml())?.[1] },
          },
        },
        workflows: {
          DIGEST_RUN: { name: "opusfinder-digest-run", className: "DigestRunWorkflow" },
          DIGEST_USER: { name: "opusfinder-digest-user", className: "DigestUserWorkflow" },
        },
        outboundService: (request: Request) => {
          outbound.push(request.url);
          return new Response("no network in this test", { status: 599 });
        },
      },
      { name: "control", modules: true, script: FAKE_CONTROL, compatibilityDate: date },
      {
        name: "observer",
        modules: true,
        script: OBSERVER,
        compatibilityDate: date,
        workflows: {
          DIGEST_RUN: {
            name: "opusfinder-digest-run",
            className: "DigestRunWorkflow",
            scriptName: "digest",
          },
          DIGEST_USER: {
            name: "opusfinder-digest-user",
            className: "DigestUserWorkflow",
            scriptName: "digest",
          },
        },
      },
    ],
  });
  await mf.ready;
  const control = await mf.getWorker("control");
  const observer = await mf.getWorker("observer");
  return {
    setGates: async (gates) => {
      await control.fetch("https://control.test/gates", {
        method: "POST",
        body: JSON.stringify(gates),
      });
    },
    fire: async (cron, scheduledTime = Date.UTC(2026, 10, 16, 12, 10)) => {
      const url = new URL("https://digest.test/cdn-cgi/handler/scheduled");
      url.searchParams.set("cron", cron);
      url.searchParams.set("time", String(scheduledTime));
      const res = await mf.dispatchFetch(url);
      await res.text();
      return res.ok;
    },
    ledger: async () =>
      (await (await control.fetch("https://control.test/rows")).json()) as Record<
        string,
        unknown
      >[],
    instance: async (workflow, id) =>
      (await (
        await observer.fetch("https://observer.test/", {
          method: "POST",
          body: JSON.stringify({ workflow, id }),
        })
      ).json()) as Awaited<ReturnType<DigestWorker["instance"]>>,
    outbound,
    dispose: () => mf.dispose(),
  };
}
