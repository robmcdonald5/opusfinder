import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startControl, type ControlHarness } from "@test/control/harness";

// The ControlRpc entrypoint, called through REAL service bindings from a second Worker (how the scrapers
// Worker will reach it in a later slice). A binding caller is the runtime role: it can read a gate, write
// a ledger row and trip a stage off — and the surface is exactly those three methods.

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

describe("ControlRpc over a service binding", () => {
  it("gate() returns the same answer as GET /v1/gate", async () => {
    const rpc = await h.rpc("RPC", "gate", "ingest", { source: "lever" });
    const http = (await (
      await h.request("/v1/gate/ingest?source=lever", { as: "runtime" })
    ).json()) as object;
    expect(rpc).toEqual({ ok: true, value: http });
    expect(rpc.value).toMatchObject({
      stage: "ingest",
      mode: "on",
      knobs: { boardsPerTick: 250 },
    });
  });

  it("gate() throws for an unknown stage (the caller must then skip: fail-closed)", async () => {
    const res = await h.rpc("RPC", "gate", "nope");
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/unknown stage/);
  });

  it("recordRun() writes a ledger row labelled with the binding's props name", async () => {
    const res = await h.rpc("RPC", "recordRun", {
      stage: "ingest",
      outcome: "skipped",
      startedAt: "2026-10-04T11:00:00Z",
      gateMode: "off",
      detail: "gate=off (shadow: not enforced)",
    });
    expect(res.ok).toBe(true);
    const row = await h.db
      .prepare("SELECT * FROM ledger ORDER BY id DESC LIMIT 1")
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      stage: "ingest",
      outcome: "skipped",
      gate_mode: "off",
      recorded_by: "runtime:cf:opusfinder-scrapers",
    });
  });

  it("labels a binding without props generically — the role is runtime either way", async () => {
    await h.rpc("RPC_ANON", "recordRun", {
      stage: "discover",
      outcome: "ok",
      startedAt: "2026-10-04T03:00:00Z",
    });
    const row = await h.db
      .prepare("SELECT recorded_by FROM ledger ORDER BY id DESC LIMIT 1")
      .first<{ recorded_by: string }>();
    expect(row?.recorded_by).toBe("runtime:service-binding");
  });

  it("trip() turns a stage off via channel rpc", async () => {
    const res = await h.rpc("RPC", "trip", "discover", "runaway", "subrequests 5x normal");
    expect(res).toMatchObject({ ok: true, value: { result: "tripped", stage: "discover" } });
    const log = await h.db
      .prepare("SELECT * FROM change_log ORDER BY id DESC LIMIT 1")
      .first<Record<string, unknown>>();
    expect(log).toMatchObject({
      target: "discover",
      to_value: "off",
      channel: "rpc",
      actor_role: "runtime",
      actor_name: "cf:opusfinder-scrapers",
      reason: "trip: runaway — subrequests 5x normal",
    });
  });

  it("trip() refuses a reason outside the registry's list", async () => {
    const res = await h.rpc("RPC", "trip", "discover", "bored");
    expect(res.ok).toBe(false);
    const row = await h.db
      .prepare("SELECT value FROM state WHERE key = 'discover'")
      .first<{ value: string }>();
    expect(row?.value).toBe("on");
  });

  it.each(["requestChange", "approve", "status", "fetch"])(
    "exposes no %s method over RPC",
    async (method) => {
      const res = await h.rpc("RPC", method, { target: "embed", value: "on", reason: "x" });
      expect(res.ok).toBe(false);
      const row = await h.db
        .prepare("SELECT value FROM state WHERE key = 'embed'")
        .first<{ value: string }>();
      expect(row?.value).toBe("off");
    },
  );
});
