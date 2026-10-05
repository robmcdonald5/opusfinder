import { describe, expect, it } from "vitest";

import { EXIT, main, type CliDeps } from "./cli";

// `pnpm ctl` against a scripted fetch: what it sends (Access service-token headers, the change body,
// proposeIfNeeded only when unattended), how it maps every API outcome to a stable exit code, and that
// the client secret never reaches stdout/stderr on any path.

const SECRET = "s3cr3t-client-secret-value-0123456789abcdef";
const URL_BASE = "https://opusfinder-control.example.workers.dev";

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

function harness(replies: Reply[], opts: { isTTY?: boolean; answer?: string } = {}) {
  const sent: Sent[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const queue = [...replies];
  const deps: CliDeps = {
    env: {
      OPUSFINDER_CTL_URL: URL_BASE,
      OPUSFINDER_CTL_CLIENT_ID: "agent.access",
      OPUSFINDER_CTL_CLIENT_SECRET: SECRET,
    },
    home: "/home/agent",
    readFile: () => null,
    fileMode: () => null,
    fetch: async (url, init) => {
      sent.push({
        url,
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      const r = queue.shift();
      if (!r) throw new Error("no scripted reply left");
      if (r instanceof Error) throw r;
      return new Response(
        r.body === undefined ? null : typeof r.body === "string" ? r.body : JSON.stringify(r.body),
        {
          status: r.status,
          headers: r.headers ?? { "content-type": "application/json" },
        },
      );
    },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    isTTY: opts.isTTY ?? false,
    prompt: async (q) => {
      prompts.push(q);
      return opts.answer ?? "";
    },
  };
  return {
    sent,
    prompts,
    run: (argv: string[]) => main(argv, deps),
    output: () => [...out, ...err].join("\n"),
    stdout: () => out.join("\n"),
  };
}

const STATUS = {
  generatedAt: "2026-10-04T18:00:00.000Z",
  caller: { role: "agent", name: "observer" },
  global: { desired: "on" },
  stages: [
    {
      id: "ingest",
      desired: "on",
      effective: "on",
      cappedBy: null,
      overrides: [{ target: "ingest@source=gem", override: "off" }],
      knobs: [{ target: "ingest.boardsPerTick", value: 75, source: "set" }],
      lastRun: { outcome: "ok", started_at: "2026-10-04T17:00:00.000Z" },
    },
  ],
  policies: [
    {
      id: "health.digest_health",
      desired: "shadow",
      effective: "shadow",
      agent: "approval",
      knobs: [],
    },
  ],
  openProposals: [
    {
      id: 4,
      target: "embed",
      from_value: "off",
      to_value: "on",
      reason: "drain",
      status: "open",
      proposer: "agent:observer",
      expires_at: "2026-10-11T00:00:00.000Z",
    },
  ],
  recentChanges: [
    {
      at: "2026-10-04T17:30:00.000Z",
      target: "ingest",
      from_value: "off",
      to_value: "on",
      actor_role: "owner",
      actor_name: "o@x",
      channel: "panel",
      reason: "resume",
    },
  ],
};

const needsApproval = {
  status: 403,
  body: {
    error: {
      code: "needs_approval",
      message: "embed: a move toward more spend/risk needs owner approval",
    },
    propose: {},
  },
};

describe("argument handling (offline)", () => {
  it("prints usage for help and no command", async () => {
    for (const argv of [["help"], [], ["--help"]]) {
      const h = harness([]);
      expect(await h.run(argv)).toBe(EXIT.ok);
      expect(h.stdout()).toContain("usage: pnpm ctl");
    }
  });

  it.each([
    [["frobnicate"]],
    [["set", "nope", "on", "--reason", "x"]],
    [["set", "ingest", "shadow", "--reason", "x"]],
    [["set", "ingest.boardsPerTick", "501", "--reason", "x"]],
    [["set", "embed", "on"]],
    [["set", "embed", "on", "--reason", "   "]],
    [["set", "embed", "--reason", "x"]],
    [["set", "embed", "on", "--propose", "--no-propose", "--reason", "x"]],
    [["withdraw", "abc"]],
    [["status", "extra"]],
    [["status", "--bogus"]],
  ])("rejects %j as a usage error without any network call", async (argv) => {
    const h = harness([]);
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.sent).toEqual([]);
  });

  it("reports missing config without a network call", async () => {
    let called = false;
    const errs: string[] = [];
    const code = await main(["status"], {
      env: {},
      home: "/home/agent",
      readFile: () => null,
      fileMode: () => null,
      fetch: async () => {
        called = true;
        throw new Error("must not be called");
      },
      stdout: () => {},
      stderr: (t) => errs.push(t),
      isTTY: false,
      prompt: async () => "",
    });
    expect(code).toBe(EXIT.error);
    expect(called).toBe(false);
    expect(errs.join("\n")).toContain("config: missing url, clientId, clientSecret");
  });
});

describe("requests", () => {
  it("authenticates with the Access service-token headers and marks itself as the CLI", async () => {
    const h = harness([{ status: 200, body: STATUS }]);
    expect(await h.run(["status", "--json"])).toBe(EXIT.ok);
    expect(h.sent[0]).toMatchObject({
      url: `${URL_BASE}/v1/status`,
      method: "GET",
      headers: {
        "cf-access-client-id": "agent.access",
        "cf-access-client-secret": SECRET,
        "x-opusfinder-client": "ctl",
      },
    });
    expect(JSON.parse(h.stdout())).toEqual(STATUS);
  });

  it("prints a readable status", async () => {
    const h = harness([{ status: 200, body: STATUS }]);
    await h.run(["status"]);
    const text = h.stdout();
    expect(text).toMatch(/ingest\s+on\s+on\s+ok 2026-10-04 17:00Z/);
    expect(text).toContain("overrides: ingest@source=gem=off");
    expect(text).toContain("knobs (non-default): ingest.boardsPerTick=75");
    expect(text).toContain("#4 embed: off → on by agent:observer [open]");
    expect(text).toContain("resume");
  });

  it("lists proposals, all statuses with --all", async () => {
    const h = harness([{ status: 200, body: { proposals: [] } }]);
    await h.run(["proposals", "--all"]);
    expect(h.sent[0]?.url).toBe(`${URL_BASE}/v1/proposals?status=all`);
    expect(h.stdout()).toBe("no proposals");
  });

  it("withdraws by id (a leading # is fine)", async () => {
    const h = harness([{ status: 200, body: { proposal: { id: 4, status: "withdrawn" } } }]);
    expect(await h.run(["withdraw", "#4"])).toBe(EXIT.ok);
    expect(h.sent[0]).toMatchObject({ url: `${URL_BASE}/v1/proposals/4/withdraw`, method: "POST" });
  });
});

describe("set", () => {
  it("applies an allowed change (exit 0)", async () => {
    const h = harness(
      [
        {
          status: 200,
          body: { result: "applied", target: "ingest", from: "on", to: "off", changeId: 12 },
        },
      ],
      { isTTY: true },
    );
    expect(await h.run(["set", "ingest", "off", "--reason", "token spike, investigating"])).toBe(
      EXIT.ok,
    );
    expect(h.sent[0]).toMatchObject({
      url: `${URL_BASE}/v1/changes`,
      method: "POST",
      body: { target: "ingest", value: "off", reason: "token spike, investigating" },
    });
    expect(h.sent[0]?.body).not.toHaveProperty("proposeIfNeeded");
    expect(h.stdout()).toBe("applied: ingest on → off (change #12)");
  });

  it("files the proposal in one call when unattended and prints its id (exit 3)", async () => {
    const h = harness([
      {
        status: 202,
        body: { result: "proposed", duplicate: false, proposal: { id: 13 }, decision: {} },
      },
    ]);
    expect(await h.run(["set", "embed", "on", "--reason", "backlog drained"])).toBe(EXIT.proposed);
    expect(h.sent[0]?.body).toMatchObject({ proposeIfNeeded: true });
    expect(h.stdout()).toContain("needs owner approval: created proposal #13");
  });

  it("asks at a terminal, then files the proposal on yes (exit 3)", async () => {
    const h = harness(
      [needsApproval, { status: 201, body: { proposal: { id: 14 }, duplicate: false } }],
      { isTTY: true, answer: "y" },
    );
    expect(await h.run(["set", "embed", "on", "--reason", "go"])).toBe(EXIT.proposed);
    expect(h.prompts[0]).toContain("File a proposal for the owner?");
    expect(h.sent[1]).toMatchObject({
      url: `${URL_BASE}/v1/proposals`,
      body: { target: "embed", value: "on", reason: "go" },
    });
    expect(h.stdout()).toContain("created proposal #14");
  });

  it("files nothing when the terminal answer is no, or with --no-propose (exit 4)", async () => {
    const no = harness([needsApproval], { isTTY: true, answer: "n" });
    expect(await no.run(["set", "embed", "on", "--reason", "go"])).toBe(EXIT.notApplied);
    expect(no.sent).toHaveLength(1);
    const unattended = harness([needsApproval]);
    expect(await unattended.run(["set", "embed", "on", "--reason", "go", "--no-propose"])).toBe(
      EXIT.notApplied,
    );
    expect(unattended.sent[0]?.body).not.toHaveProperty("proposeIfNeeded");
  });

  it("forces a proposal from a terminal with --propose", async () => {
    const h = harness(
      [{ status: 202, body: { result: "proposed", duplicate: true, proposal: { id: 13 } } }],
      { isTTY: true },
    );
    expect(await h.run(["set", "embed", "on", "--reason", "go", "--propose"])).toBe(EXIT.proposed);
    expect(h.stdout()).toContain("already proposed as #13");
  });

  it("sends inherit to clear an override and dryRun on request", async () => {
    const h = harness([
      {
        status: 200,
        body: {
          result: "dry_run",
          from: "off",
          to: null,
          decision: { outcome: "propose", rule: "r" },
        },
      },
    ]);
    expect(await h.run(["set", "ingest@source=gem", "inherit", "--reason", "x", "--dry-run"])).toBe(
      EXIT.ok,
    );
    expect(h.sent[0]?.body).toMatchObject({
      target: "ingest@source=gem",
      value: "inherit",
      dryRun: true,
    });
    expect(h.stdout()).toContain("dry run: ingest@source=gem off → inherit: propose");
  });
});

describe("failures never leak the secret", () => {
  it.each<[string, Reply, RegExp]>([
    [
      "an Access login redirect",
      { status: 302, headers: { location: "https://team.cloudflareaccess.com/login" } },
      /refused the service token/,
    ],
    [
      "an Access HTML block page",
      { status: 403, body: "<html>Forbidden</html>", headers: { "content-type": "text/html" } },
      /likely Cloudflare Access/,
    ],
    [
      "an API error",
      {
        status: 403,
        body: { error: { code: "forbidden", message: "the agent role can't do this" } },
      },
      /\(forbidden\)/,
    ],
    [
      "a network failure",
      new TypeError("fetch failed"),
      /could not reach https:\/\/opusfinder-control/,
    ],
  ])("exits 1 on %s", async (_label, reply, message) => {
    const h = harness([reply]);
    expect(await h.run(["set", "ingest", "off", "--reason", "x"])).toBe(EXIT.error);
    expect(h.output()).toMatch(message);
    expect(h.output()).not.toContain(SECRET);
  });

  it("keeps the secret out of every output across a full session", async () => {
    const h = harness([{ status: 200, body: STATUS }, needsApproval, { status: 302 }]);
    await h.run(["status"]);
    await h.run(["set", "embed", "on", "--reason", "x", "--no-propose", "--json"]);
    await h.run(["proposals", "--json"]);
    expect(h.output()).not.toContain(SECRET);
  });
});
