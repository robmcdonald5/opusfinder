/**
 * Unit suite for the pure health-alert render helpers (src/health-alert-helpers.ts). Locks the per-check-id
 * formatMetric switch (7 arms + the null-metric short-circuit + the defensive default), the thresholdSuffix
 * two-branch, and the checkDetail composition + its shape-only / no-leak invariant (email line === stored
 * health_alerts.detail; no NaN / undefined / '[threshold null]').
 */
import { describe, expect, it } from "vitest";

import type { HealthCheck, HealthCheckId } from "@opusfinder/db/health";

import { checkDetail, formatMetric, thresholdSuffix } from "./health-alert-helpers";

function check(over: Partial<HealthCheck> & { id: HealthCheckId }): HealthCheck {
  return { label: over.id, state: "firing", metric: 4.2, threshold: 3, mode: "enforce", ...over } as HealthCheck;
}

describe("formatMetric", () => {
  it.each([
    ["ingestion_staleness", 4.2, "4.2h since last ok"],
    ["discovery_window", 4.2, "4.2d since last ok"],
    ["board_fail_ratio", 0.25, "25% boards failed"],
    ["embedding_backlog", 128, "128 rows"],
    ["digest_health", 3, "3 errored run(s)"],
    ["bounce_suppression", 5, "5 affected user(s)"],
    ["discovery_lane_errors", 2, "2 lane error(s)"],
  ])("renders %s shape-only", (id, metric, expected) => {
    expect(formatMetric(check({ id: id as HealthCheckId, metric }))).toBe(expected);
  });

  it("short-circuits a null metric to 'no data' (before the id switch)", () => {
    expect(formatMetric(check({ id: "ingestion_staleness", metric: null }))).toBe("no data");
    // Even for an id with a bespoke arm — the null guard wins.
    expect(formatMetric(check({ id: "board_fail_ratio", metric: null }))).toBe("no data");
  });

  it("falls back to String(metric) for an unknown id (the defensive default arm)", () => {
    // HealthCheckId is a closed union, so this arm is unreachable by type — cast to exercise it.
    expect(formatMetric(check({ id: "future_check" as HealthCheckId, metric: 9 }))).toBe("9");
  });
});

describe("thresholdSuffix", () => {
  it("renders ` [threshold N]` for a numeric-threshold check", () => {
    expect(thresholdSuffix(check({ id: "embedding_backlog", threshold: 100 }))).toBe(" [threshold 100]");
  });

  it("renders '' for a boolean check (threshold null)", () => {
    expect(thresholdSuffix(check({ id: "digest_health", threshold: null }))).toBe("");
  });
});

describe("checkDetail", () => {
  it("composes label (id): metric + suffix for a numeric check", () => {
    expect(
      checkDetail(check({ id: "embedding_backlog", label: "Embedding backlog", metric: 128, threshold: 100 })),
    ).toBe("Embedding backlog (embedding_backlog): 128 rows [threshold 100]");
  });

  it("omits the threshold suffix for a boolean check", () => {
    expect(
      checkDetail(check({ id: "digest_health", label: "Digest health", metric: 2, threshold: null })),
    ).toBe("Digest health (digest_health): 2 errored run(s)");
  });

  it("renders 'no data' for a null metric and keeps the numeric suffix", () => {
    expect(
      checkDetail(check({ id: "ingestion_staleness", label: "Ingestion staleness", metric: null, threshold: 3 })),
    ).toBe("Ingestion staleness (ingestion_staleness): no data [threshold 3]");
  });

  it("never leaks NaN / undefined / '[threshold null]' across the null/boolean edges", () => {
    for (const line of [
      checkDetail(check({ id: "digest_health", label: "Digest health", metric: 2, threshold: null })),
      checkDetail(check({ id: "ingestion_staleness", label: "Ingestion staleness", metric: null, threshold: null })),
    ]) {
      expect(line).not.toContain("NaN");
      expect(line).not.toContain("undefined");
      expect(line).not.toContain("[threshold null]");
    }
  });
});
