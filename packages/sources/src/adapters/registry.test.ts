import { describe, expect, it } from "vitest";

import type { SourceName } from "@opusfinder/shared";
import { rejectionOf } from "@test/rejection";

import {
  SOURCE_NAMES,
  adapterFor,
  adapters,
  fetchJobs,
  paceMsOf,
  pacesByKey,
  pacingKeyOf,
} from "./index";

// Leaf pure-unit for the source registry's lookups (no network: an unknown source fails before any fetch).

// Ingestion paces boards per PACING KEY (runIngestion's paceMs). Every registered adapter must resolve one
// — declared (`pacingKey`) or defaulted (its source) — and the defaults encode the host audit in types.ts:
// no two adapters share a request host today, so each paces alone. Adding a shared-host adapter means
// declaring a shared key AND updating the audit expectation below.
describe("pacingKeyOf — every adapter declares or defaults a pacing key", () => {
  it.each(SOURCE_NAMES)("%s resolves a non-empty pacing key", (source) => {
    const key = pacingKeyOf(adapters[source]);
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
  });

  it("today every adapter defaults to its own source (the host audit: no two share a host)", () => {
    expect(SOURCE_NAMES.map((source) => pacingKeyOf(adapters[source]))).toEqual(SOURCE_NAMES);
  });

  it("a declared pacingKey wins over the source", () => {
    expect(pacingKeyOf({ ...adapters.recruitee, pacingKey: "one-vendor" })).toBe("one-vendor");
  });

  it("only Workable declares a slower pace (1000 ms); paceMsOf resolves it per key, 0 elsewhere", () => {
    const declared = SOURCE_NAMES.filter((s) => adapters[s].paceMs !== undefined).map((s) => [
      s,
      adapters[s].paceMs,
    ]);
    expect(declared).toEqual([["workable", 1000]]);
    expect(SOURCE_NAMES.map((s) => [s, paceMsOf(s)])).toEqual(
      SOURCE_NAMES.map((s) => [s, s === "workable" ? 1000 : 0]),
    );
  });

  it("pacesByKey: a shared key takes the LARGEST pace its adapters declare", () => {
    const paces = pacesByKey([
      { ...adapters.greenhouse, pacingKey: "shared", paceMs: 300 },
      { ...adapters.lever, pacingKey: "shared", paceMs: 700 },
      { ...adapters.ashby, pacingKey: "shared" },
      adapters.recruitee,
    ]);
    expect([...paces.entries()]).toEqual([
      ["shared", 700],
      ["recruitee", 0],
    ]);
  });
});

// A `companies` row's source comes from the DB, so a stale or hand-written value can reach the lookup.
describe("adapterFor / fetchJobs — an unknown source fails clearly, never as an opaque TypeError", () => {
  it.each(SOURCE_NAMES)("returns the registered adapter for %s", (source) => {
    expect(adapterFor(source)).toBe(adapters[source]);
  });

  it("adapterFor throws `unknown source \"<x>\"`", () => {
    expect(() => adapterFor("nonesuch")).toThrow(new Error('unknown source "nonesuch"'));
  });

  it("fetchJobs REJECTS (not a sync throw) with the same message", async () => {
    const err = await rejectionOf(fetchJobs("nonesuch" as SourceName, "acme"));
    expect(err.message).toBe('unknown source "nonesuch"');
  });
});
