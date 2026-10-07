import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { EXIT, main, type CliDeps } from "@opusfinder/ctl";
import {
  AGENT_CLIENT_ID,
  AccessKeys,
  ORIGIN,
  startControl,
  type ControlHarness,
} from "@test/control/harness";

// `pnpm ctl` end to end against the real Worker + local D1. The one piece of production that can't run
// locally is Cloudflare Access itself, so a tiny stand-in plays its part exactly as documented: it accepts
// the CF-Access-Client-Id/Secret pair of a known service token, strips it, and forwards the request with a
// signed application token (common_name = client id) — or answers a login redirect. This pins the CLI ⇄ API
// contract (response shapes, status codes, exit codes) on real responses rather than hand-written fixtures.

const AGENT_SECRET = "agent-secret-0123456789abcdef0123456789";

let h: ControlHarness;
beforeAll(async () => {
  h = await startControl();
}, 60_000);
afterAll(async () => {
  await h?.dispose();
});
beforeEach(async () => {
  await h.reset();
});

const accessStandIn: CliDeps["fetch"] = async (url, init) => {
  const headers = new Headers(init.headers);
  const id = headers.get("cf-access-client-id");
  const secret = headers.get("cf-access-client-secret");
  if (id !== AGENT_CLIENT_ID || secret !== AGENT_SECRET) {
    return new Response(null, {
      status: 302,
      headers: { location: "https://opusfinder-test.cloudflareaccess.com/login" },
    });
  }
  headers.delete("cf-access-client-id");
  headers.delete("cf-access-client-secret");
  headers.set("cf-access-jwt-assertion", await h.keys.sign(AccessKeys.serviceClaims(id)));
  const res = await h.mf.dispatchFetch(url, {
    method: init.method,
    headers: Object.fromEntries(headers),
    body: init.body as string | undefined,
    redirect: "manual",
  });
  return res as unknown as Response;
};

async function ctl(argv: string[], opts: { secret?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    env: {
      OPUSFINDER_CTL_URL: ORIGIN,
      OPUSFINDER_CTL_CLIENT_ID: AGENT_CLIENT_ID,
      OPUSFINDER_CTL_CLIENT_SECRET: opts.secret ?? AGENT_SECRET,
    },
    home: "/nonexistent",
    readFile: () => null,
    fileMode: () => null,
    fetch: accessStandIn,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    isTTY: false, // an unattended agent
    prompt: async () => "",
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

async function stateValue(key: string): Promise<string | null> {
  const row = await h.db
    .prepare("SELECT value FROM state WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

describe("pnpm ctl against the control Worker", () => {
  it("status --json returns the API's status for the agent identity", async () => {
    const r = await ctl(["status", "--json"]);
    expect(r.code).toBe(EXIT.ok);
    const s = JSON.parse(r.stdout) as { caller: unknown; stages: { id: string }[] };
    expect(s.caller).toEqual({ role: "agent", name: "observer" });
    expect(s.stages.map((x) => x.id)).toContain("ingest");
  });

  it("status renders a readable summary from the real payload", async () => {
    const r = await ctl(["status"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toMatch(/^ingest\s+on\s+on\s+-$/m);
    expect(r.stdout).toMatch(/^health\.digest_health\s+shadow\s+shadow\s+approval$/m);
    expect(r.stdout).toContain("slice-1 seed");
  });

  it("set applies a safe change, logged as channel cli", async () => {
    const r = await ctl(["set", "ingest", "off", "--reason", "token spike, investigating"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toMatch(/^applied: ingest on → off \(change #\d+\)$/);
    expect(await stateValue("ingest")).toBe("off");
    const log = await h.db
      .prepare("SELECT channel, actor_name FROM change_log ORDER BY id DESC LIMIT 1")
      .first();
    expect(log).toEqual({ channel: "cli", actor_name: "observer" });
  });

  it("set on a turn-on files a proposal unattended (exit 3); proposals and withdraw round-trip", async () => {
    const r = await ctl(["set", "embed", "on", "--reason", "backlog drained"]);
    expect(r.code).toBe(EXIT.proposed);
    const id = Number(/proposal #(\d+)/.exec(r.stdout)?.[1]);
    expect(id).toBeGreaterThan(0);
    expect(await stateValue("embed")).toBe("off");

    const again = await ctl(["set", "embed", "on", "--reason", "still drained"]);
    expect(again.stdout).toContain(`already proposed as #${id}`);

    const list = await ctl(["proposals", "--json"]);
    expect(
      (JSON.parse(list.stdout) as { proposals: { id: number }[] }).proposals.map((p) => p.id),
    ).toEqual([id]);
    expect((await ctl(["withdraw", String(id)])).code).toBe(EXIT.ok);
    expect((await ctl(["proposals"])).stdout).toBe("no proposals");
  });

  it("status marks an open proposal whose target moved as STALE", async () => {
    await ctl(["set", "embed", "on", "--reason", "drain"]);
    await h.request("/v1/changes", {
      as: "owner",
      json: { target: "embed", value: "shadow", reason: "count first" },
    });
    const r = await ctl(["status"]);
    expect(r.stdout).toMatch(
      /embed: off → on by agent:observer \[open\] STALE \(now shadow; re-propose\)/,
    );
  });

  it("refuses to let an agent turn the master switch off (exit 3: proposed instead)", async () => {
    const r = await ctl(["set", "global", "off", "--reason", "all off drill"]);
    expect(r.code).toBe(EXIT.proposed);
    expect(await stateValue("global")).toBe("on");
  });

  it("set --no-propose on a health check reports not applied (exit 4) and files nothing", async () => {
    const r = await ctl([
      "set",
      "health.digest_health",
      "off",
      "--reason",
      "too noisy",
      "--no-propose",
    ]);
    expect(r.code).toBe(EXIT.notApplied);
    expect(r.stdout).toContain("any agent change needs owner approval");
    const n = await h.db.prepare("SELECT COUNT(*) AS n FROM proposal").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("reports an Access refusal without leaking the secret", async () => {
    const wrong = "wrong-secret-value-should-never-print";
    const r = await ctl(["status"], { secret: wrong });
    expect(r.code).toBe(EXIT.error);
    expect(r.stderr).toContain("refused the service token");
    expect(r.stdout + r.stderr).not.toContain(wrong);
    expect(r.stdout + r.stderr).not.toContain(AGENT_SECRET);
  });
});
