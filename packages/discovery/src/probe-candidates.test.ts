import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { companySlug } from "@opusfinder/shared";
import type { SourceName } from "@opusfinder/shared";

import { fakeResponse } from "../test/http-stubs";
import { probeCandidate, probeCandidates } from "./probe";
import type { Candidate } from "./types";

// Leaf pure-unit for the candidate-level probe entry points, driven through the REAL adapter
// registry (no adapter stubs): `probeCandidate` builds a candidate's `jobsRequest`, fetches, and
// classifies — via greenhouse's DEFAULT classifier (live / live-empty / absent) and via
// smartrecruiters' `classifyProbe` override (its ambiguous 200 + totalFound:0 is indeterminate).
// `probeCandidates` runs a batch through the bounded, polite pool: results preserve INPUT order
// index-for-index, and a non-zero `hostMinIntervalMs` serializes same-host STARTS. `fetch` is
// stubbed and matched by URL substring (the greenhouse jobsRequest URL carries the rawSlug). The
// pool's per-host sleeps run on a REAL setTimeout → FAKE timers + the ASYNC advance api. Ports
// scripts/test-probe.ts (the probeCandidate/probeCandidates half).

// candidate() factory from the smoke: `slug` is branded via companySlug (Candidate.slug is a
// branded CompanySlug — a plain string would not typecheck).
const candidate = (source: SourceName, slug: string, host: string): Candidate => ({
  source,
  slug: companySlug(slug),
  rawSlug: slug,
  sourceUrl: `https://${host}/${slug}`,
});

// The current fetch stub's response producer, matched on the requested URL.
let handler: (url: string) => Response;
// Every URL fetch was invoked with, in order — asserts start-serialization under the interval gate.
let fetchCalls: string[];

beforeEach(() => {
  vi.useFakeTimers();
  handler = () => {
    throw new Error("no handler set");
  };
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      fetchCalls.push(String(url));
      return handler(String(url));
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("probeCandidate", () => {
  // greenhouse uses the DEFAULT classifier (no classifyProbe override).
  describe("greenhouse (default classifier)", () => {
    const gh = candidate("greenhouse", "acme", "boards.greenhouse.io");

    it("200 + non-empty jobs → live", async () => {
      handler = () => fakeResponse(200, JSON.stringify({ jobs: [{ id: 1, title: "x" }] }));

      expect((await probeCandidate(gh)).outcome).toBe("live");
    });

    it("200 + empty jobs → live-empty", async () => {
      handler = () => fakeResponse(200, JSON.stringify({ jobs: [] }));

      expect((await probeCandidate(gh)).outcome).toBe("live-empty");
    });

    it("404 → absent", async () => {
      handler = () => fakeResponse(404, "not found");

      expect((await probeCandidate(gh)).outcome).toBe("absent");
    });
  });

  // smartrecruiters overrides classifyProbe: an unknown slug returns 200 + totalFound:0 (NOT 404).
  describe("smartrecruiters (classifyProbe override)", () => {
    const sr = candidate("smartrecruiters", "Ghost", "jobs.smartrecruiters.com");

    it("200 + totalFound:0 → indeterminate (unassertable, never absent)", async () => {
      handler = () => fakeResponse(200, JSON.stringify({ content: [], totalFound: 0 }));

      expect((await probeCandidate(sr)).outcome).toBe("indeterminate");
    });

    it("200 + totalFound:1 → live", async () => {
      handler = () => fakeResponse(200, JSON.stringify({ content: [{}], totalFound: 1 }));

      expect((await probeCandidate(sr)).outcome).toBe("live");
    });
  });
});

describe("probeCandidates", () => {
  // A same-host greenhouse batch; the greenhouse jobsRequest URL carries the rawSlug (".../bravo/...").
  const batch = (): Candidate[] => [
    candidate("greenhouse", "alpha", "boards.greenhouse.io"),
    candidate("greenhouse", "bravo", "boards.greenhouse.io"),
    candidate("greenhouse", "charlie", "boards.greenhouse.io"),
  ];

  it("preserves INPUT order index-for-index and routes per-candidate outcomes", async () => {
    handler = (url) =>
      url.includes("/bravo/")
        ? fakeResponse(404, "gone")
        : fakeResponse(200, JSON.stringify({ jobs: [{ id: 1, title: "x" }] }));

    // hostMinIntervalMs:0 so the three same-host probes don't serialize on the interval gate.
    const results = await probeCandidates(batch(), { hostMinIntervalMs: 0 });

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.candidate.rawSlug)).toEqual(["alpha", "bravo", "charlie"]);
    expect(results.map((r) => r.outcome)).toEqual(["live", "absent", "live"]);
  });

  it("serializes same-host STARTS under a non-zero hostMinIntervalMs", async () => {
    handler = () => fakeResponse(200, JSON.stringify({ jobs: [{ id: 1, title: "x" }] }));

    const promise = probeCandidates(batch(), { hostMinIntervalMs: 500 });

    // Flush microtasks: the first probe issues its fetch; the other two block on the 500ms gate.
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchCalls).toHaveLength(1);

    // Each 500ms interval releases exactly the next start.
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchCalls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(500);
    expect(fetchCalls).toHaveLength(3);

    const results = await promise;
    expect(results.map((r) => r.candidate.rawSlug)).toEqual(["alpha", "bravo", "charlie"]);
    expect(results.map((r) => r.outcome)).toEqual(["live", "live", "live"]);
  });
});
