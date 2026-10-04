import { describe, expect, it } from "vitest";

import {
  DIMENSIONS,
  MODE_RANK,
  POLICY_IDS,
  PROPOSAL_TTL_MS,
  STAGE_IDS,
  globalSwitch,
  policyDef,
  stageDef,
  stages,
  type Knob,
} from "./registry";

// Structural invariants of the registry that the rest of the control plane silently relies on: the
// address grammar (targets.ts) needs ids free of `@`/`=` and knob names free of `.`; the ratchet needs
// every entry's modes listed safest-first; fail-closed layer 1 needs `initial` to be a settable mode.

const ENTRY_IDS = [...STAGE_IDS, ...POLICY_IDS];

function allKnobs(): [string, Knob][] {
  const out: [string, Knob][] = [];
  for (const id of STAGE_IDS) {
    for (const [k, v] of Object.entries(stageDef(id).knobs ?? {})) out.push([`${id}.${k}`, v]);
  }
  for (const id of POLICY_IDS) {
    for (const [k, v] of Object.entries(policyDef(id).knobs ?? {})) out.push([`${id}.${k}`, v]);
  }
  return out;
}

describe("registry: identifiers", () => {
  it("stage and policy ids are unique, never 'global', and free of the address separators", () => {
    expect(new Set(ENTRY_IDS).size).toBe(ENTRY_IDS.length);
    expect(ENTRY_IDS).not.toContain("global");
    for (const id of ENTRY_IDS) expect(id).toMatch(/^[a-z][a-z0-9_.]*[a-z0-9]$/);
  });

  it("knob names are plain identifiers (a knob address splits at the LAST dot)", () => {
    for (const [address] of allKnobs()) {
      const name = address.slice(address.lastIndexOf(".") + 1);
      expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
    }
  });

  it("every declared dimension exists and its values are plain identifiers", () => {
    for (const id of STAGE_IDS) {
      for (const dim of stageDef(id).dims ?? []) expect(Object.keys(DIMENSIONS)).toContain(dim);
    }
    for (const values of Object.values(DIMENSIONS)) {
      expect(new Set(values).size).toBe(values.length);
      for (const v of values) expect(v).toMatch(/^[a-z0-9_-]+$/);
    }
  });
});

describe("registry: modes", () => {
  it("lists every entry's modes strictly safest-first, with initial among them", () => {
    const entries = [
      ["global", globalSwitch.modes, globalSwitch.initial] as const,
      ...STAGE_IDS.map((id) => [id, stageDef(id).modes, stageDef(id).initial] as const),
      ...POLICY_IDS.map((id) => [id, policyDef(id).modes, policyDef(id).initial] as const),
    ];
    for (const [id, modes, initial] of entries) {
      const ranks = modes.map((m) => MODE_RANK[m]);
      for (let i = 1; i < ranks.length; i++) {
        expect(ranks[i], `${id} modes must ascend`).toBeGreaterThan(ranks[i - 1] ?? -1);
      }
      expect(modes, id).toContain(initial);
    }
  });

  it("every stage lists 'off' first — a stage can always be turned off", () => {
    for (const id of STAGE_IDS) expect(stageDef(id).modes[0]).toBe("off");
  });

  it("every stage fails closed when the store can't be read", () => {
    for (const id of STAGE_IDS) expect(stageDef(id).onUnreadable).toBe("skip");
  });

  it("seeds today's reality (§12.1) as the registry defaults", () => {
    const initial = Object.fromEntries([
      ["global", globalSwitch.initial],
      ...STAGE_IDS.map((id) => [id, stageDef(id).initial]),
      ...POLICY_IDS.map((id) => [id, policyDef(id).initial]),
    ]);
    expect(initial).toEqual({
      global: "on",
      ingest: "on",
      discover: "on",
      embed: "off",
      alerts: "off",
      digest: "off",
      live_integration: "off",
      cv_ingest: "on",
      close: "enforce",
      stale_sweep: "shadow",
      "health.ingestion_staleness": "shadow",
      "health.board_fail_ratio": "shadow",
      "health.discovery_window": "shadow",
      "health.discovery_lane_errors": "shadow",
      "health.embedding_backlog": "shadow",
      "health.digest_health": "shadow",
      "health.bounce_suppression": "shadow",
    });
  });
});

describe("registry: knobs", () => {
  it("every knob's default sits inside its range, and int knobs are whole numbers", () => {
    for (const [address, knob] of allKnobs()) {
      expect(knob.min, address).toBeLessThanOrEqual(knob.default);
      expect(knob.default, address).toBeLessThanOrEqual(knob.max);
      if (knob.int) {
        for (const n of [knob.min, knob.default, knob.max])
          expect(Number.isInteger(n), address).toBe(true);
      }
    }
  });

  it("declares ingest.concurrency as the owner specified (default 1, min 1, riskier up, legacy env)", () => {
    // max is deliberately NOT pinned here: it mirrors the scrapers Worker's MAX_INGEST_CONCURRENCY clamp
    // (branch perf/ingest-concurrency), and a sync test against that constant replaces a copied number
    // once this branch rebases onto it.
    const { max, ...rest } = stages.ingest.knobs.concurrency;
    expect(rest).toEqual({
      label: expect.any(String),
      default: 1,
      min: 1,
      riskier: "up",
      int: true,
      legacyEnv: "INGEST_CONCURRENCY",
    });
    expect(max).toBeGreaterThanOrEqual(1);
  });

  it("pins every knob's risky side (a flip changes what an agent may do alone)", () => {
    expect(
      Object.fromEntries(allKnobs().map(([address, knob]) => [address, knob.riskier])),
    ).toEqual({
      "ingest.boardsPerTick": "up", // more boards per tick: more Neon time and subrequests
      "ingest.concurrency": "up", // more parallel lanes: more load per tick
      "discover.limit": "up", // more seed slugs probed: more subrequests and Neon writes
      "discover.reprobeLimit": "up", // more re-probes: same
      "embed.pagesPerRun": "up", // more pages: more Voyage tokens
      "embed.tokensPerRun": "up", // a higher token cap: more Voyage spend
      "alerts.cooldownH": "down", // a SHORTER cooldown re-pages sooner: more emails
      "digest.topK": "up", // more jobs per digest: more rerank tokens
      "digest.maxRecipientsPerRun": "up", // more recipients: more LLM + email spend
      "stale_sweep.ttlDays": "down", // a SHORTER TTL closes more jobs
      "health.ingestion_staleness.threshold": "up", // looser: an outage goes unnoticed longer
      "health.board_fail_ratio.threshold": "up", // looser: same
      "health.discovery_window.threshold": "up", // looser: same
      "health.embedding_backlog.threshold": "up", // looser: same
    });
  });
});

describe("registry: agent rules", () => {
  it("marks exactly global, the alerts stage and the 7 health checks as 'approval' (owner decisions)", () => {
    expect(globalSwitch.agent).toBe("approval");
    expect(STAGE_IDS.filter((id) => stageDef(id).agent === "approval")).toEqual(["alerts"]);
    expect(POLICY_IDS.filter((id) => policyDef(id).agent === "approval")).toEqual([
      "health.ingestion_staleness",
      "health.board_fail_ratio",
      "health.discovery_window",
      "health.discovery_lane_errors",
      "health.embedding_backlog",
      "health.digest_health",
      "health.bounce_suppression",
    ]);
    // Every other entry an agent may stop on its own: each single spending stage, close, stale_sweep.
    for (const id of STAGE_IDS.filter((s) => s !== "alerts")) {
      expect(stageDef(id).agent ?? "safe-direction", id).toBe("safe-direction");
    }
    for (const id of ["close", "stale_sweep"] as const) {
      expect(policyDef(id).agent ?? "safe-direction", id).toBe("safe-direction");
    }
  });

  it("health checks watch a real stage and are read by the alerts stage", () => {
    for (const id of POLICY_IDS.filter((p) => p.startsWith("health."))) {
      expect(STAGE_IDS).toContain(policyDef(id).watches);
      expect(policyDef(id).readBy).toEqual(["alerts"]);
    }
  });

  it("proposals lapse after 7 days", () => {
    expect(PROPOSAL_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
