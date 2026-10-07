import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DIMENSIONS,
  POLICY_IDS,
  STAGE_IDS,
  globalSwitch,
  policyDef,
  stageDef,
  type DimKey,
} from "@opusfinder/control";
import { ORIGIN, startControl, type ControlHarness } from "@test/control/harness";

import { MAX_BODY_BYTES } from "./limits";

// The JSON API against a real local D1: seed = registry, classify() enforced per role, the approval queue,
// the ledger, trips — and the C3 invariant that a state change and its change_log row land together or
// not at all.

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

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-side JSON probing

async function body(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function stateValue(key: string): Promise<string | null> {
  const row = await h.db
    .prepare("SELECT value FROM state WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function changeCount(): Promise<number> {
  return (
    (await h.db.prepare("SELECT COUNT(*) AS n FROM change_log").first<{ n: number }>())?.n ?? -1
  );
}

async function lastLog(): Promise<Json | null> {
  return h.db.prepare("SELECT * FROM change_log ORDER BY id DESC LIMIT 1").first<Json>();
}

const change = (as: "owner" | "agent", target: string, value: string, extra: Json = {}) =>
  h.request("/v1/changes", {
    as,
    json: { target, value, reason: `test ${target} → ${value}`, ...extra },
  });

describe("seed (migration 0002) = today's reality = the registry defaults", () => {
  it("stores every mode row at its registry `initial`, each with a seed change_log row", async () => {
    const { results } = await h.db
      .prepare("SELECT key, value FROM state ORDER BY key")
      .all<{ key: string; value: string }>();
    const expected: Record<string, string> = { global: globalSwitch.initial };
    for (const id of STAGE_IDS) expected[id] = stageDef(id).initial;
    for (const id of POLICY_IDS) expected[id] = policyDef(id).initial;
    expect(Object.fromEntries(results.map((r) => [r.key, r.value]))).toEqual(expected);

    const log = await h.db
      .prepare("SELECT actor_role, channel, from_value, to_value, target FROM change_log")
      .all<Json>();
    expect(log.results).toHaveLength(results.length);
    for (const row of log.results) {
      expect(row).toMatchObject({
        actor_role: "seed",
        channel: "migration",
        from_value: null,
        to_value: expected[row.target],
      });
    }
  });

  it("reports the seeded reality through /v1/status", async () => {
    const s = await body(await h.request("/v1/status", { as: "agent" }));
    const modes = Object.fromEntries(
      s.stages.map((x: Json) => [x.id, [x.desired, x.effective, x.source]]),
    );
    expect(modes).toMatchObject({
      ingest: ["on", "on", "set"],
      discover: ["on", "on", "set"],
      embed: ["off", "off", "set"],
      cv_ingest: ["on", "on", "set"],
    });
    const policies = Object.fromEntries(s.policies.map((p: Json) => [p.id, p.effective]));
    expect(policies).toMatchObject({
      close: "enforce",
      stale_sweep: "shadow",
      "health.digest_health": "shadow",
    });
    expect(s.openProposals).toEqual([]);
    expect(s.recentChanges.length).toBeGreaterThan(0);
  });
});

describe("POST /v1/changes", () => {
  it("lets an agent apply a safe change: logged with its identity, reflected in the gate", async () => {
    const res = await change("agent", "ingest", "off");
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      result: "applied",
      target: "ingest",
      from: "on",
      to: "off",
    });
    expect(await stateValue("ingest")).toBe("off");
    expect(await lastLog()).toMatchObject({
      actor_role: "agent",
      actor_name: "observer",
      target: "ingest",
      from_value: "on",
      to_value: "off",
      reason: "test ingest → off",
      channel: "api",
      proposal_id: null,
    });
    const gate = await body(await h.request("/v1/gate/ingest", { as: "runtime" }));
    expect(gate).toMatchObject({ mode: "off", by: "agent:observer", because: "test ingest → off" });
  });

  it("marks requests from the CLI as channel 'cli' (audit metadata only)", async () => {
    await h.request("/v1/changes", {
      as: "agent",
      headers: { "x-opusfinder-client": "ctl" },
      json: { target: "ingest.boardsPerTick", value: 75, reason: "smaller ticks" },
    });
    expect(await lastLog()).toMatchObject({ channel: "cli", to_value: "75" });
  });

  it("refuses an agent turning a stage on: 403 needs_approval with a ready-to-send proposal, nothing written", async () => {
    const before = await changeCount();
    const res = await change("agent", "embed", "on");
    expect(res.status).toBe(403);
    const b = await body(res);
    expect(b.error.code).toBe("needs_approval");
    expect(b.propose).toEqual({
      method: "POST",
      path: "/v1/proposals",
      body: { target: "embed", value: "on", reason: "test embed → on" },
    });
    expect(await stateValue("embed")).toBe("off");
    expect(await changeCount()).toBe(before);
  });

  it("files the proposal in the same call with proposeIfNeeded — idempotently", async () => {
    const first = await change("agent", "embed", "shadow", { proposeIfNeeded: true });
    expect(first.status).toBe(202);
    const a = await body(first);
    expect(a).toMatchObject({
      result: "proposed",
      duplicate: false,
      proposal: { target: "embed", to_value: "shadow", status: "open" },
    });
    const again = await body(await change("agent", "embed", "shadow", { proposeIfNeeded: true }));
    expect(again).toMatchObject({
      result: "proposed",
      duplicate: true,
      proposal: { id: a.proposal.id },
    });
    expect(await stateValue("embed")).toBe("off");
  });

  it.each<[string, string]>([
    ["health.board_fail_ratio", "off"], // quieter
    ["health.board_fail_ratio", "enforce"], // louder
    ["health.board_fail_ratio.threshold", "0.9"], // looser
    ["health.board_fail_ratio.threshold", "0.1"], // tighter
  ])(
    "needs owner approval for ANY agent change to a health check (%s → %s)",
    async (target, value) => {
      const res = await change("agent", target, value);
      expect(res.status).toBe(403);
      expect((await body(res)).error.code).toBe("needs_approval");
    },
  );

  it("lets the owner apply anything, including turning spend on", async () => {
    const res = await change("owner", "embed", "on");
    expect(res.status).toBe(200);
    expect(await stateValue("embed")).toBe("on");
    expect(await lastLog()).toMatchObject({ actor_role: "owner", actor_name: "owner@example.com" });
  });

  it("narrows one source with an override (agent-safe) and refuses removing it (needs approval)", async () => {
    expect((await change("agent", "ingest@source=smartrecruiters", "off")).status).toBe(200);
    const gate = await body(await h.request("/v1/gate/ingest", { as: "runtime" }));
    expect(gate.overrides).toEqual({ source: { smartrecruiters: "off" } });
    expect(gate.mode).toBe("on");
    const narrowed = await body(
      await h.request("/v1/gate/ingest?source=smartrecruiters", { as: "runtime" }),
    );
    expect(narrowed).toMatchObject({ mode: "off", cappedBy: "source=smartrecruiters" });

    const clear = await change("agent", "ingest@source=smartrecruiters", "inherit");
    expect(clear.status).toBe(403);
    // The owner can clear it; the row is deleted and the log records to_value NULL.
    expect((await change("owner", "ingest@source=smartrecruiters", "inherit")).status).toBe(200);
    expect(await stateValue("ingest@source=smartrecruiters")).toBeNull();
    expect(await lastLog()).toMatchObject({ from_value: "off", to_value: null });
  });

  it("needs the owner to flip the master switch — off as well as on", async () => {
    for (const value of ["off", "on"]) {
      if (value === "on") await change("owner", "global", "off");
      const res = await change("agent", "global", value);
      expect(res.status, value).toBe(403);
      expect((await body(res)).error.code).toBe("needs_approval");
    }
  });

  it("caps everything at off when the owner flips the master switch off", async () => {
    expect((await change("owner", "global", "off")).status).toBe(200);
    const gate = await body(await h.request("/v1/gate/ingest", { as: "runtime" }));
    expect(gate).toMatchObject({ mode: "off", desired: "on", cappedBy: "global" });
  });

  it("won't let an agent silence alerting: alerts off and its cooldown need approval", async () => {
    await change("owner", "alerts", "on");
    const before = await changeCount();
    for (const [target, value] of [
      ["alerts", "off"],
      ["alerts.cooldownH", "168"],
      ["alerts.cooldownH", "1"],
    ] as const) {
      const res = await change("agent", target, value);
      expect(res.status, `${target} ${value}`).toBe(403);
      expect((await body(res)).error.code).toBe("needs_approval");
    }
    expect(await stateValue("alerts")).toBe("on");
    expect(await changeCount()).toBe(before);
  });

  it("still lets an agent stop any single spending stage on its own", async () => {
    for (const stage of ["ingest", "discover", "cv_ingest"]) {
      expect((await change("agent", stage, "off")).status, stage).toBe(200);
    }
  });

  it("treats setting an override at the inherited mode as a true no-op: no row, no log", async () => {
    const before = await changeCount();
    const res = await change("agent", "ingest@source=gem", "on");
    expect(await body(res)).toEqual({ result: "noop", target: "ingest@source=gem", value: null });
    expect(await stateValue("ingest@source=gem")).toBeNull();
    expect(await changeCount()).toBe(before);
    // The owner's request is the same no-op.
    expect((await body(await change("owner", "ingest@source=gem", "on"))).result).toBe("noop");
    expect(await changeCount()).toBe(before);
  });

  it("treats re-setting the current value as a no-op (no log row)", async () => {
    const before = await changeCount();
    expect(await body(await change("agent", "embed", "off"))).toEqual({
      result: "noop",
      target: "embed",
      value: "off",
    });
    // A knob with no row whose default already matches is a no-op too.
    expect((await body(await change("agent", "ingest.boardsPerTick", "250"))).result).toBe("noop");
    expect(await changeCount()).toBe(before);
  });

  it("answers dryRun with the decision and writes nothing", async () => {
    const before = await changeCount();
    const res = await body(await change("agent", "embed", "on", { dryRun: true }));
    expect(res).toMatchObject({
      result: "dry_run",
      decision: { outcome: "propose", direction: "up" },
    });
    expect(await changeCount()).toBe(before);
  });

  it("repairs an unreadable stored value (read as off) when anyone sets it", async () => {
    await h.db.prepare("UPDATE state SET value = 'garbage' WHERE key = 'ingest'").run();
    const gate = await body(await h.request("/v1/gate/ingest", { as: "runtime" }));
    expect(gate.mode).toBe("off"); // fail-closed layer 2
    expect((await change("agent", "ingest", "off")).status).toBe(200);
    expect(await stateValue("ingest")).toBe("off");
  });

  it.each<[string, Json, number, string]>([
    ["an unknown target", { target: "nope", value: "on", reason: "x" }, 400, "invalid_target"],
    [
      "a mode the entry lacks",
      { target: "ingest", value: "shadow", reason: "x" },
      400,
      "invalid_value",
    ],
    [
      "an out-of-range knob",
      { target: "ingest.boardsPerTick", value: "501", reason: "x" },
      400,
      "invalid_value",
    ],
    ["a missing reason", { target: "ingest", value: "off" }, 400, "invalid_reason"],
    [
      "an over-long reason",
      { target: "ingest", value: "off", reason: "x".repeat(301) },
      400,
      "invalid_reason",
    ],
    ["a missing value", { target: "ingest", reason: "x" }, 400, "invalid_value"],
  ])("rejects %s", async (_label, json, status, code) => {
    const res = await h.request("/v1/changes", { as: "owner", json });
    expect(res.status).toBe(status);
    expect((await body(res)).error.code).toBe(code);
  });

  it("only accepts JSON bodies (no cross-site form can drive the API)", async () => {
    for (const body of [undefined, "target=embed&value=on&reason=x"]) {
      const form = await h.request("/v1/changes", {
        as: "owner",
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      expect(form.status).toBe(415);
    }
    const untyped = await h.request("/v1/changes", { as: "owner", method: "POST", body: "{}" });
    expect(untyped.status).toBe(415);
    const broken = await h.request("/v1/changes", {
      as: "owner",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(broken.status).toBe(400);
    expect((await body(broken)).error.code).toBe("invalid_json");
    const huge = await h.request("/v1/changes", {
      as: "owner",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "ingest", value: "off", reason: "x".repeat(20_000) }),
    });
    expect(huge.status).toBe(413);
  });

  it("measures the 16 KB limit in bytes, not characters", async () => {
    // 6,000 three-byte characters: 6,000 code units (under 16,384) but 18,000 bytes (over it).
    const res = await h.request("/v1/changes", {
      as: "owner",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "ingest", value: "off", reason: "€".repeat(6000) }),
    });
    expect(res.status).toBe(413);
  });

  it("caps an undeclared (chunked) body while streaming it", { timeout: 15_000 }, async () => {
    // No Content-Length: the up-front check can't fire, so only the running byte count stops it. The
    // stream sends exactly one byte over the cap, then holds itself open (pull() waits) until the
    // response is in. So nothing is left to write once the Worker answers (no write to a closed socket),
    // and only a Worker that refuses MID-STREAM can answer at all: one that read to EOF before checking
    // the size would wait forever on the held stream, and the test times out.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(MAX_BODY_BYTES + 1).fill(0x20)); // JSON whitespace
          return;
        }
        await held;
        controller.close();
      },
    });
    try {
      const res = await h.mf.dispatchFetch(`${ORIGIN}/v1/changes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-access-jwt-assertion": await h.token("owner"),
        },
        body: stream,
        duplex: "half",
      } as never);
      expect(res.status).toBe(413);
      expect((await body(res as unknown as Response)).error.code).toBe("too_large");
    } finally {
      release();
    }
  });

  it.each([
    ["null", "null"],
    ["an array", "[1, 2]"],
    ["a string", '"approve"'],
    ["a number", "42"],
  ])("rejects a JSON body that is %s with 400 invalid_body", async (_label, raw) => {
    for (const path of ["/v1/changes", "/v1/proposals/1/approve", "/v1/proposals/1/reject"]) {
      const res = await h.request(path, {
        as: "owner",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      expect(res.status, path).toBe(400);
      expect((await body(res)).error.code).toBe("invalid_body");
    }
  });

  it.each([
    ["a foreign Origin", { origin: "https://evil.example" }],
    ["Sec-Fetch-Site: cross-site", { "sec-fetch-site": "cross-site" }],
    ["Sec-Fetch-Site: same-site", { "sec-fetch-site": "same-site" }],
  ])("refuses a state change marked %s (CSRF), even with no body", async (_label, headers) => {
    const p = (
      await body(
        await h.request("/v1/proposals", {
          as: "agent",
          json: { target: "embed", value: "on", reason: "x" },
        }),
      )
    ).proposal;
    const res = await h.request(`/v1/proposals/${p.id}/approve`, {
      as: "owner",
      method: "POST",
      headers,
    });
    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe("cross_origin");
    expect(await stateValue("embed")).toBe("off");
  });
});

describe("gate dimensions", () => {
  it("honours every dimension the registry declares as a query parameter", async () => {
    const dims = Object.keys(DIMENSIONS) as DimKey[];
    expect(dims.length).toBeGreaterThan(0);
    for (const dim of dims) {
      const stage = STAGE_IDS.find((id) => (stageDef(id).dims ?? []).includes(dim));
      const value = DIMENSIONS[dim][0];
      if (!stage || !value) throw new Error(`no stage is narrowed by ${dim}`);
      await change("owner", `${stage}@${dim}=${value}`, "off");
      const gate = await body(
        await h.request(`/v1/gate/${stage}?${dim}=${encodeURIComponent(value)}`, { as: "runtime" }),
      );
      expect(gate, dim).toMatchObject({ mode: "off", cappedBy: `${dim}=${value}` });
    }
  });
});

describe("the approval queue", () => {
  async function fileProposal(target = "embed", value = "on"): Promise<Json> {
    const res = await h.request("/v1/proposals", {
      as: "agent",
      json: { target, value, reason: "backlog is drained" },
    });
    expect(res.status).toBe(201);
    return (await body(res)).proposal;
  }

  it("approve applies the change atomically and logs proposer + approver", async () => {
    const p = await fileProposal();
    expect(p).toMatchObject({
      status: "open",
      proposer: "agent:observer",
      from_value: "off",
      to_value: "on",
    });
    const res = await h.request(`/v1/proposals/${p.id}/approve`, {
      as: "owner",
      json: { note: "go" },
    });
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      result: "applied",
      proposal: { status: "approved", decided_by: "owner:owner@example.com", decision_note: "go" },
    });
    expect(await stateValue("embed")).toBe("on");
    expect(await lastLog()).toMatchObject({
      actor_role: "owner",
      proposal_id: p.id,
      reason: "backlog is drained",
    });
    const s = await body(await h.request("/v1/status", { as: "agent" }));
    expect(s.recentChanges[0]).toMatchObject({ proposed_by: "agent:observer", proposal_id: p.id });
    expect(s.openProposals).toEqual([]);
    // A proposal can be decided once.
    expect(
      (await h.request(`/v1/proposals/${p.id}/approve`, { as: "owner", json: {} })).status,
    ).toBe(409);
  });

  it("reject closes it without touching state", async () => {
    const p = await fileProposal();
    const res = await h.request(`/v1/proposals/${p.id}/reject`, {
      as: "owner",
      json: { note: "not yet" },
    });
    expect((await body(res)).proposal).toMatchObject({
      status: "rejected",
      decision_note: "not yet",
    });
    expect(await stateValue("embed")).toBe("off");
    expect(
      (await h.request(`/v1/proposals/${p.id}/approve`, { as: "owner", json: {} })).status,
    ).toBe(409);
  });

  it("only the proposer can withdraw", async () => {
    const p = await fileProposal();
    expect(
      (await h.request(`/v1/proposals/${p.id}/withdraw`, { as: "other-agent", json: {} })).status,
    ).toBe(403);
    expect(
      (await h.request(`/v1/proposals/${p.id}/withdraw`, { as: "owner", json: {} })).status,
    ).toBe(403);
    const res = await h.request(`/v1/proposals/${p.id}/withdraw`, { as: "agent", json: {} });
    expect((await body(res)).proposal.status).toBe("withdrawn");
    expect(
      (await h.request(`/v1/proposals/${p.id}/approve`, { as: "owner", json: {} })).status,
    ).toBe(409);
  });

  it("expires after 7 days: hidden from the open list, unapprovable", async () => {
    const p = await fileProposal();
    expect(Date.parse(p.expires_at) - Date.parse(p.created_at)).toBe(7 * 24 * 60 * 60 * 1000);
    await h.db
      .prepare("UPDATE proposal SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .bind(p.id)
      .run();
    expect((await body(await h.request("/v1/proposals", { as: "agent" }))).proposals).toEqual([]);
    const all = (await body(await h.request("/v1/proposals?status=all", { as: "agent" })))
      .proposals;
    expect(all[0]).toMatchObject({ id: p.id, status: "expired" });
    const approve = await h.request(`/v1/proposals/${p.id}/approve`, { as: "owner", json: {} });
    expect(approve.status).toBe(409);
    expect((await body(approve)).error.code).toBe("expired");
    expect(await stateValue("embed")).toBe("off");
  });

  it("refuses a STALE proposal (target moved since filing): 409, closed as stale, nothing applied", async () => {
    const p = await fileProposal("embed", "on");
    await change("owner", "embed", "shadow");
    const before = await changeCount();
    const res = await h.request(`/v1/proposals/${p.id}/approve`, { as: "owner", json: {} });
    expect(res.status).toBe(409);
    const b = await body(res);
    expect(b.error.code).toBe("stale_proposal");
    expect(b.proposal).toMatchObject({ id: p.id, status: "stale" });
    expect(b.proposal.decision_note).toMatch(
      /embed is now shadow, proposed from off; nothing applied/,
    );
    expect(await stateValue("embed")).toBe("shadow");
    expect(await changeCount()).toBe(before);
    // It is closed: a second approve is not_open, and status lists it as stale, not open.
    expect(
      (await h.request(`/v1/proposals/${p.id}/approve`, { as: "owner", method: "POST" })).status,
    ).toBe(409);
    const s = await body(await h.request("/v1/status", { as: "agent" }));
    expect(s.openProposals).toEqual([]);
    expect(s.closedProposals[0]).toMatchObject({ id: p.id, status: "stale" });
  });

  it("flags an open proposal as stale in /v1/status before anyone tries to approve it", async () => {
    const p = await fileProposal("embed", "on");
    let s = await body(await h.request("/v1/status", { as: "agent" }));
    expect(s.openProposals[0]).toMatchObject({ id: p.id, stale: false, current: "off" });
    await change("owner", "embed", "shadow");
    s = await body(await h.request("/v1/status", { as: "agent" }));
    expect(s.openProposals[0]).toMatchObject({ id: p.id, stale: true, current: "shadow" });
  });

  it("files a fresh proposal once the old one's starting value no longer holds", async () => {
    const old = await fileProposal("embed", "on");
    await change("owner", "embed", "shadow");
    const fresh = await fileProposal("embed", "on");
    expect(fresh.id).not.toBe(old.id);
    expect(fresh).toMatchObject({ from_value: "shadow", to_value: "on" });
    // Body-less, no content type — what the page's API callers and `curl -X POST` send.
    const res = await h.request(`/v1/proposals/${fresh.id}/approve`, {
      as: "owner",
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await stateValue("embed")).toBe("on");
  });

  it("treats a target that already holds the proposed value as stale too (nothing left to approve)", async () => {
    const p = await fileProposal();
    await change("owner", "embed", "on");
    const before = await changeCount();
    const raw = await h.request(`/v1/proposals/${p.id}/approve`, { as: "owner", json: {} });
    expect(raw.status).toBe(409);
    const res = await body(raw);
    expect(res).toMatchObject({
      error: { code: "stale_proposal" },
      proposal: { status: "stale", decision_note: expect.stringMatching(/embed is now on/) },
    });
    expect(await changeCount()).toBe(before);
  });

  it("refuses to propose what is already in effect, and dedupes identical open proposals", async () => {
    const same = await h.request("/v1/proposals", {
      as: "agent",
      json: { target: "embed", value: "off", reason: "x" },
    });
    expect(same.status).toBe(409);
    const p = await fileProposal();
    const dup = await h.request("/v1/proposals", {
      as: "agent",
      json: { target: "embed", value: "on", reason: "again" },
    });
    expect(dup.status).toBe(200);
    expect((await body(dup)).proposal.id).toBe(p.id);
  });

  it("returns 404 for an unknown proposal", async () => {
    expect((await h.request("/v1/proposals/999", { as: "agent" })).status).toBe(404);
    expect((await h.request("/v1/proposals/999/approve", { as: "owner", json: {} })).status).toBe(
      404,
    );
  });
});

describe("runtime: ledger + trip", () => {
  const run = (json: Json) => h.request("/v1/runs", { as: "runtime", json });

  it("records a run and surfaces it as the stage's last run", async () => {
    const res = await run({
      stage: "ingest",
      outcome: "ok",
      startedAt: "2026-10-04T10:00:00Z",
      finishedAt: "2026-10-04T10:05:12Z",
      durationMs: 312000,
      gateMode: "on",
      units: { "cf.wall_ms": 312000, "cf.subrequests": 1800 },
      detail: "boards=150 failed=2\nsecond line must not be stored",
    });
    expect(res.status).toBe(201);
    const s = await body(await h.request("/v1/status", { as: "agent" }));
    const ingest = s.stages.find((x: Json) => x.id === "ingest");
    expect(ingest.lastRun).toMatchObject({
      outcome: "ok",
      started_at: "2026-10-04T10:00:00.000Z",
      units: { "cf.wall_ms": 312000, "cf.subrequests": 1800 },
      detail: "boards=150 failed=2",
      recorded_by: "runtime:runtime-inngest",
    });
  });

  it.each<[string, Json]>([
    ["an unknown stage", { stage: "nope", outcome: "ok", startedAt: "2026-10-04T10:00:00Z" }],
    ["a bad outcome", { stage: "ingest", outcome: "great", startedAt: "2026-10-04T10:00:00Z" }],
    [
      "a unit the stage doesn't record",
      {
        stage: "ingest",
        outcome: "ok",
        startedAt: "2026-10-04T10:00:00Z",
        units: { "voyage.tokens": 5 },
      },
    ],
    [
      "a negative unit",
      {
        stage: "embed",
        outcome: "ok",
        startedAt: "2026-10-04T10:00:00Z",
        units: { "voyage.tokens": -5 },
      },
    ],
    ["a missing start time", { stage: "ingest", outcome: "ok" }],
    [
      "a gate mode the stage lacks",
      { stage: "ingest", outcome: "ok", startedAt: "2026-10-04T10:00:00Z", gateMode: "shadow" },
    ],
    // Out-of-range numbers: each must be a 400 the runtime sees, never a D1 500.
    [
      "a duration over 7 days",
      {
        stage: "ingest",
        outcome: "ok",
        startedAt: "2026-10-04T10:00:00Z",
        durationMs: 7 * 86_400_000 + 1,
      },
    ],
    [
      "an astronomically large duration",
      { stage: "ingest", outcome: "ok", startedAt: "2026-10-04T10:00:00Z", durationMs: 1e300 },
    ],
    [
      "a unit above MAX_SAFE_INTEGER",
      {
        stage: "ingest",
        outcome: "ok",
        startedAt: "2026-10-04T10:00:00Z",
        units: { "cf.wall_ms": 2 ** 60 },
      },
    ],
    ["a year-0 start time", { stage: "ingest", outcome: "ok", startedAt: "0000-01-01T00:00:00Z" }],
    [
      "a finish before the start",
      {
        stage: "ingest",
        outcome: "ok",
        startedAt: "2026-10-04T10:00:00Z",
        finishedAt: "2026-10-04T09:00:00Z",
      },
    ],
  ])("rejects %s with 400 invalid_run", async (_label, json) => {
    const res = await run(json);
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("invalid_run");
  });

  it("accepts the largest bounded values", async () => {
    const res = await run({
      stage: "ingest",
      outcome: "ok",
      startedAt: "2026-10-04T10:00:00Z",
      durationMs: 7 * 86_400_000,
      units: { "cf.wall_ms": Number.MAX_SAFE_INTEGER },
    });
    expect(res.status).toBe(201);
  });

  it("trips a stage off with a logged reason, and a second trip is a no-op", async () => {
    const res = await h.request("/v1/trip", {
      as: "runtime",
      json: { stage: "ingest", reason: "error-storm", detail: "40 of 40 boards failed\nstack…" },
    });
    expect(await body(res)).toMatchObject({ result: "tripped", stage: "ingest", from: "on" });
    expect(await stateValue("ingest")).toBe("off");
    expect(await lastLog()).toMatchObject({
      actor_role: "runtime",
      actor_name: "runtime-inngest",
      to_value: "off",
      reason: "trip: error-storm — 40 of 40 boards failed",
    });
    const again = await h.request("/v1/trip", {
      as: "runtime",
      json: { stage: "ingest", reason: "runaway" },
    });
    expect((await body(again)).result).toBe("noop");
  });

  it("refuses a trip reason outside the registry's list", async () => {
    const res = await h.request("/v1/trip", {
      as: "runtime",
      json: { stage: "ingest", reason: "because" },
    });
    expect(res.status).toBe(400);
    expect(await stateValue("ingest")).toBe("on");
  });
});

describe("C3: a state change and its change_log row commit together or not at all", () => {
  // Make ONE half of the write fail inside D1 (a trigger raising ABORT) and check the other half didn't land.

  it("leaves no log row when the state write fails", async () => {
    await h.db
      .prepare(
        "CREATE TRIGGER fail_state_write BEFORE UPDATE ON state BEGIN SELECT RAISE(ABORT, 'injected'); END",
      )
      .run();
    const before = await changeCount();
    const res = await change("owner", "embed", "on");
    expect(res.status).toBe(500);
    expect(await changeCount()).toBe(before);
    expect(await stateValue("embed")).toBe("off");
  });

  it("leaves the state untouched when the log write fails", async () => {
    await h.db
      .prepare(
        "CREATE TRIGGER fail_log_write BEFORE INSERT ON change_log BEGIN SELECT RAISE(ABORT, 'injected'); END",
      )
      .run();
    const res = await change("owner", "embed", "on");
    expect(res.status).toBe(500);
    expect(await stateValue("embed")).toBe("off");
  });

  it("applies nothing on approval when closing the proposal fails", async () => {
    const p = (
      await body(
        await h.request("/v1/proposals", {
          as: "agent",
          json: { target: "embed", value: "on", reason: "x" },
        }),
      )
    ).proposal;
    await h.db
      .prepare(
        "CREATE TRIGGER fail_close BEFORE UPDATE ON proposal BEGIN SELECT RAISE(ABORT, 'injected'); END",
      )
      .run();
    const before = await changeCount();
    expect(
      (await h.request(`/v1/proposals/${p.id}/approve`, { as: "owner", json: {} })).status,
    ).toBe(500);
    expect(await stateValue("embed")).toBe("off");
    expect(await changeCount()).toBe(before);
  });

  it("does not leak SQL or internals in the 500 body", async () => {
    await h.db
      .prepare(
        "CREATE TRIGGER fail_state_write BEFORE UPDATE ON state BEGIN SELECT RAISE(ABORT, 'injected'); END",
      )
      .run();
    const res = await change("owner", "embed", "on");
    expect(await body(res)).toEqual({
      error: { code: "internal", message: "internal error (see Worker logs)" },
    });
  });
});

describe("compare-and-set: a change lands only on the value it was classified against", () => {
  // The race this closes: an agent classifies embed on→shadow (down: allowed) while a runtime trips embed
  // off; if the agent's write landed second, embed would go off→shadow — UP — with no approval. Driven
  // here through store.applyChange with a stale `expected`, since the API can't be raced deterministically.
  const agent = { role: "agent", name: "observer" };
  const input = (over: Json) => ({
    target: "embed",
    expected: "on",
    from: "on",
    to: "shadow",
    actor: agent,
    channel: "api",
    reason: "classified against on",
    now: new Date().toISOString(),
    ...over,
  });

  it("applies when the store still holds the classified value", async () => {
    await h.db.prepare("UPDATE state SET value = 'on' WHERE key = 'embed'").run();
    const res = await h.applyChange(input({}));
    expect(res.applied).toBe(true);
    expect(await stateValue("embed")).toBe("shadow");
    expect(await lastLog()).toMatchObject({
      target: "embed",
      from_value: "on",
      to_value: "shadow",
    });
  });

  it("writes NEITHER state nor log when the value moved underneath (tripped to off)", async () => {
    // The seed holds embed=off: the stale `expected: "on"` must not match.
    const before = await changeCount();
    const res = await h.applyChange(input({}));
    expect(res.applied).toBe(false);
    expect(await stateValue("embed")).toBe("off");
    expect(await changeCount()).toBe(before);
  });

  it("treats 'no row' as a value: a stale expectation of absence doesn't match an existing row", async () => {
    const before = await changeCount();
    const res = await h.applyChange(
      input({ target: "ingest@source=gem", expected: null, from: null, to: "off" }),
    );
    expect(res.applied).toBe(true);
    const again = await h.applyChange(
      input({ target: "ingest@source=gem", expected: null, from: null, to: "on" }),
    );
    expect(again.applied).toBe(false);
    expect(await stateValue("ingest@source=gem")).toBe("off");
    expect(await changeCount()).toBe(before + 1);
  });

  it("refuses an approval batch for a proposal that is no longer open", async () => {
    const p = (
      await body(
        await h.request("/v1/proposals", {
          as: "agent",
          json: { target: "embed", value: "on", reason: "x" },
        }),
      )
    ).proposal;
    await h.request(`/v1/proposals/${p.id}/reject`, { as: "owner", json: {} });
    const before = await changeCount();
    const res = await h.applyChange(
      input({
        expected: "off",
        from: "off",
        to: "on",
        actor: { role: "owner", name: "o" },
        proposal: { id: p.id, decidedBy: "owner:o", note: null },
      }),
    );
    expect(res.applied).toBe(false);
    expect(await stateValue("embed")).toBe("off");
    expect(await changeCount()).toBe(before);
  });
});
