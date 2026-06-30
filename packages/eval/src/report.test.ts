import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { diffReports, formatReport, ppDelta, readReport, writeReport, type EvalReport } from "./report";

// Leaf pure-unit. node:fs is MOCKED — no tmpdir, no disk — so this pins the report's load-bearing
// invariants, not I/O: JSON has no NaN literal, so writeReport serializes an undefined metric as
// `null` and readReport must coerce that null back to NaN (else null→0 fabricates a delta exactly
// when a metric is undefined); a structurally-bad or missing file reads as null (degrade to "new
// baseline", never crash diffReports); and ppDelta renders a full swing in-width. Ports the report
// cases from scripts/test-metrics.ts, dropping the on-disk round-trip in favor of mocked fs.
vi.mock("node:fs");

const NAN_METRICS = {
  k: 3,
  precision: 0.5,
  recall: NaN,
  ndcg: NaN,
  counts: { precision: 1, recall: 0, ndcg: 0 },
};

const REPORT: EvalReport = {
  ranker: "random",
  embedder: null,
  dataset: "d",
  exampleCount: 1,
  metrics: [NAN_METRICS],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ppDelta", () => {
  it.each([
    { label: "one side undefined → n/a", a: NaN, b: 0.5, both: undefined, expected: "n/a" },
    { label: "both undefined → caller token", a: NaN, b: NaN, both: "=", expected: "=" },
    { label: "full 0→1 swing renders in-width", a: 0, b: 1, both: undefined, expected: "+100.0pp" },
    { label: "equal runs → unsigned 0.0pp (never -0.0pp)", a: 0.5, b: 0.5, both: undefined, expected: "0.0pp" },
  ])("$label", ({ a, b, both, expected }) => {
    const out = both === undefined ? ppDelta(a, b) : ppDelta(a, b, both);
    expect(out.trim()).toBe(expected);
    expect(out.length).toBe(8); // right-padded to 8 — a full ±100.0pp swing fits the cell
  });
});

describe("writeReport", () => {
  it("serializes a NaN metric as JSON null and ends with a newline", () => {
    writeReport("reports/x.json", REPORT);
    expect(mkdirSync).toHaveBeenCalledWith("reports", { recursive: true });
    const written = vi.mocked(writeFileSync).mock.calls[0]?.[1] as string;
    expect(written.endsWith("\n")).toBe(true);
    expect(JSON.parse(written).metrics[0].recall).toBeNull(); // NaN → null (no NaN JSON literal)
  });
});

describe("readReport", () => {
  it("coerces a serialized null metric back to NaN", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(REPORT)); // NaN already → null here
    const back = readReport("reports/x.json");
    expect(back).not.toBeNull();
    expect(back?.metrics[0]?.recall).toBeNaN();
    expect(back?.metrics[0]?.precision).toBe(0.5);
  });

  it.each([
    { label: "missing metrics array", contents: "{}" },
    { label: "malformed JSON", contents: "{ not json" },
    { label: "a metric entry without a numeric k", contents: '{"metrics":[{"precision":1}]}' },
  ])("returns null for $label", ({ contents }) => {
    vi.mocked(readFileSync).mockReturnValue(contents);
    expect(readReport("reports/x.json")).toBeNull();
  });

  it("returns null when the file is missing (readFileSync throws)", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(readReport("reports/missing.json")).toBeNull();
  });
});

describe("diffReports", () => {
  it("an undefined metric on both sides diffs to '=', not a fabricated number", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(REPORT));
    const prev = readReport("reports/x.json"); // recall/ndcg are NaN both runs
    const out = diffReports(prev, REPORT);
    // precision is 0.5 both runs → an unsigned "0.0pp"; recall + ndcg are NaN both runs → "=" each.
    expect(out).toContain("0.0pp");
    expect(out.match(/=/g)).toHaveLength(2);
  });

  it("null prev establishes a baseline instead of throwing", () => {
    expect(diffReports(null, REPORT)).toContain("establishes the baseline");
  });
});

describe("formatReport", () => {
  it("renders an undefined metric as 'n/a', never the nonsensical 'n/a%'", () => {
    const out = formatReport(REPORT);
    expect(out).toContain("R    n/a"); // recall NaN → padded n/a
    expect(out).not.toContain("n/a%");
    expect(out).toContain("ranker=random");
  });
});
