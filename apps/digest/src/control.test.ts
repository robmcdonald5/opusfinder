/**
 * This Worker's reading of the control plane, against gate answers built by the registry's own `gateView`:
 * off and unreadable both mean off, the `close` policy, the per-tick limit, the health checks' modes and
 * thresholds, and the ledger rows. Plus the sync between the registry, wrangler.toml and the cron
 * constants, which the pure registry can't import.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  gateView,
  policies,
  stages,
  type GateAnswer,
  type PolicyDef,
  type StageId,
} from "@opusfinder/control";
import { healthOptionsFromEnv, type HealthCheckId } from "@opusfinder/db/health";
import {
  DIGEST_CADENCE_CRON,
  getHealthAlertCooldownH,
  HEALTH_CHECK_CRON,
} from "@opusfinder/digest";

import {
  closeEnforced,
  GATE_TIMEOUT_MS,
  healthVars,
  maxUsersPerTick,
  readGate,
  recordRun,
  runRecord,
  tickGate,
  type ControlBinding,
} from "./control";

const wranglerToml = readFileSync(
  fileURLToPath(new URL("../wrangler.toml", import.meta.url)),
  "utf8",
);

/** The gate the control Worker would answer for `stage` with these stored rows (none = registry defaults). */
function answer(stage: StageId, rows: Record<string, string> = {}): GateAnswer {
  return {
    ...gateView(new Map(Object.entries(rows)), stage),
    since: null,
    by: null,
    because: null,
  };
}

function control(rows: Record<string, string> = {}): ControlBinding {
  return {
    gate: async (stage) => answer(stage, rows),
    recordRun: vi.fn(async () => ({ id: 1 })),
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the tick's gate", () => {
  it("both stages are off until someone turns them on", async () => {
    expect((await tickGate(control(), "digest"))?.mode).toBe("off");
    expect((await tickGate(control(), "alerts"))?.mode).toBe("off");
  });

  it.each([
    ["digest", "shadow"],
    ["digest", "on"],
    ["alerts", "on"],
  ] as const)("reads %s = %s", async (stage, mode) => {
    expect((await tickGate(control({ [stage]: mode }), stage))?.mode).toBe(mode);
  });

  it("the master switch off turns a stage off", async () => {
    expect((await tickGate(control({ digest: "on", global: "off" }), "digest"))?.mode).toBe("off");
  });

  it.each<[string, ControlBinding | undefined]>([
    ["no CONTROL binding", undefined],
    [
      "a control Worker that throws",
      { ...control(), gate: () => Promise.reject(new Error("D1 down")) },
    ],
    [
      "a mode the stage doesn't have",
      { ...control(), gate: async () => ({ ...answer("alerts"), mode: "shadow" }) },
    ],
    ["an answer with no mode", { ...control(), gate: async () => ({}) as GateAnswer }],
  ])("is unreadable (so the tick does nothing) with %s", async (_what, binding) => {
    expect(await tickGate(binding, "alerts")).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("control gate alerts: unreadable, so off"),
    );
  });

  it("is unreadable when the control Worker doesn't answer in time", async () => {
    vi.useFakeTimers();
    const silent: ControlBinding = { ...control(), gate: () => new Promise(() => undefined) };
    const pending = tickGate(silent, "digest");
    await vi.advanceTimersByTimeAsync(GATE_TIMEOUT_MS);
    expect(await pending).toBeNull();
  });

  it("readGate throws on the same cases, for the send step to retry", async () => {
    await expect(readGate(undefined, "digest")).rejects.toThrow("no CONTROL binding");
  });
});

describe("what the digest stage reads from its gate", () => {
  it("the 410 close follows the `close` policy row, and anything unreadable is not enforced", async () => {
    expect(await closeEnforced(control())).toBe(policies.close.initial === "enforce");
    expect(await closeEnforced(control({ close: "enforce" }))).toBe(true);
    expect(await closeEnforced(control({ close: "shadow" }))).toBe(false);
    expect(await closeEnforced(undefined)).toBe(false);
    expect(
      await closeEnforced({ ...control(), gate: async () => ({ mode: "on" }) as GateAnswer }),
    ).toBe(false);
  });

  it("the most users one tick starts is the stage's maxRecipientsPerRun", () => {
    expect(maxUsersPerTick(answer("digest"))).toBe(stages.digest.knobs.maxRecipientsPerRun.default);
    expect(maxUsersPerTick(answer("digest", { "digest.maxRecipientsPerRun": "3" }))).toBe(3);
    expect(maxUsersPerTick(answer("digest", { "digest.maxRecipientsPerRun": "0" }))).toBe(0);
    expect(maxUsersPerTick({ knobs: {} } as GateAnswer)).toBe(10);
    expect(maxUsersPerTick({} as GateAnswer)).toBe(10);
  });
});

describe("what the health tick reads from its gate", () => {
  const modesOf = (rows: Record<string, string>) =>
    healthOptionsFromEnv(healthVars(answer("alerts", rows))).modes ?? {};

  it("no check emails by default: none is in enforce", () => {
    expect(Object.values(modesOf({ alerts: "on" }))).not.toContain("enforce");
    expect(console.warn).not.toHaveBeenCalled(); // every id it sends is one db/health knows
  });

  it("a check whose row says enforce is the only one that emails", () => {
    const modes = modesOf({
      alerts: "on",
      ingest: "on",
      "health.ingestion_staleness": "enforce",
      "health.board_fail_ratio": "off",
    });
    expect(modes.ingestion_staleness).toBe("enforce");
    expect(modes.board_fail_ratio).toBe("off");
    expect(Object.values(modes).filter((m) => m === "enforce")).toHaveLength(1);
  });

  it("a check is skipped while the stage it watches is off, even if its row says enforce", () => {
    const rows = { alerts: "on", "health.digest_health": "enforce" };
    expect(modesOf({ ...rows, digest: "off" }).digest_health).toBe("off");
    expect(modesOf({ ...rows, digest: "on" }).digest_health).toBe("enforce");
  });

  it("every threshold on the panel reaches its check", () => {
    for (const [id, def] of Object.entries(policies) as [string, PolicyDef][]) {
      const knob = def.knobs?.threshold;
      if (!id.startsWith("health.") || !knob) continue;
      const defaults = healthOptionsFromEnv({}).thresholds ?? {};
      const set = healthOptionsFromEnv(
        healthVars(answer("alerts", { [`${id}.threshold`]: String(knob.max) })),
      ).thresholds;
      // Exactly one threshold moved, to the panel's value.
      const moved = Object.entries(set ?? {}).filter(
        ([key, value]) => value !== (defaults as Record<string, number>)[key],
      );
      expect(
        moved.map(([, value]) => value),
        id,
      ).toContain(knob.max);
    }
  });

  it("every health check in the registry reaches db/health under an id it knows", () => {
    const sent = healthVars(
      answer("alerts", Object.fromEntries(healthIds().map((id) => [id, "off"]))),
    ).HEALTH_OFF!;
    expect(sent.split(",").sort()).toEqual(healthIds().sort());
    // db/health warns about an id it doesn't know and leaves that check in shadow.
    const modes: Partial<Record<HealthCheckId, string>> =
      healthOptionsFromEnv({ HEALTH_OFF: sent }).modes ?? {};
    expect(console.warn).not.toHaveBeenCalled();
    expect(Object.keys(modes)).toHaveLength(healthIds().length);
  });

  it("the alert cooldown is the stage's cooldownH", () => {
    expect(getHealthAlertCooldownH(healthVars(answer("alerts")))).toBe(
      stages.alerts.knobs.cooldownH.default,
    );
    expect(getHealthAlertCooldownH(healthVars(answer("alerts", { "alerts.cooldownH": "6" })))).toBe(
      6,
    );
  });
});

function healthIds(): string[] {
  return Object.keys(policies).filter((id) => id.startsWith("health."));
}

describe("ledger rows", () => {
  it.each(["digest", "alerts"] as const)(
    "a %s row carries only units its stage declares",
    (stage) => {
      const row = runRecord(stage, 1_000, 4_500, { outcome: "ok", gateMode: "on", detail: "fine" });
      expect(row).toMatchObject({ stage, outcome: "ok", durationMs: 3_500, gateMode: "on" });
      for (const unit of Object.keys(row.units)) {
        expect(stages[stage].units as readonly string[]).toContain(unit);
      }
    },
  );

  it("keeps only the first line of a detail", () => {
    const row = runRecord("digest", 0, 1, {
      outcome: "error",
      gateMode: null,
      detail: "Failed query: select 1\nparams: someone@example.com",
    });
    expect(row.detail).toBe("Failed query: select 1");
  });

  it("a refused or failed write is logged and never thrown", async () => {
    const refusing: ControlBinding = {
      ...control(),
      recordRun: () =>
        Promise.reject(new Error("only cf:opusfinder-digest may record runs of digest")),
    };
    await expect(
      recordRun(refusing, (finishedMs) =>
        runRecord("digest", 0, finishedMs, { outcome: "ok", gateMode: "on", detail: "" }),
      ),
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("control ledger: run not recorded"),
    );
    await expect(
      recordRun(undefined, () => {
        throw new Error("unused");
      }),
    ).resolves.toBeUndefined();
  });
});

describe("registry ⇄ wrangler.toml ⇄ the Worker", () => {
  it("both stages belong to this Worker's runtime id, which its CONTROL binding carries", () => {
    const name = /props = \{ name = "([^"]+)" \}/.exec(wranglerToml)?.[1];
    expect(name).toBe("cf:opusfinder-digest");
    expect(stages.digest.runtime).toBe(name);
    expect(stages.alerts.runtime).toBe(name);
  });

  it("the deployed crons are the registry's and the ones the Worker dispatches on", () => {
    const crons = [
      ...(/crons = \[([^\]]*)\]/.exec(wranglerToml)?.[1] ?? "").matchAll(/"([^"]+)"/g),
    ].map((m) => m[1]);
    expect(crons).toEqual([DIGEST_CADENCE_CRON, HEALTH_CHECK_CRON]);
    expect(stages.digest.trigger).toEqual({ cron: DIGEST_CADENCE_CRON });
    expect(stages.alerts.trigger).toEqual({ cron: HEALTH_CHECK_CRON });
  });

  it("the digest stage names the orchestrator Workflow", () => {
    expect(wranglerToml).toContain(`name = "${stages.digest.platformId}"`);
  });

  it("both gates are enforced, both stages ship off, and no wrangler var stands in for the gate", () => {
    expect(stages.digest.gate).toBe("enforced");
    expect(stages.alerts.gate).toBe("enforced");
    expect(stages.digest.initial).toBe("off");
    expect(stages.alerts.initial).toBe("off");
    expect(wranglerToml).not.toMatch(/^\[vars\]/m);
  });
});
