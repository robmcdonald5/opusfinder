import { describe, expect, it } from "vitest";

import type { SourceName } from "@opusfinder/shared";
import { rejectionOf } from "@test/rejection";

import { SOURCE_NAMES, adapterFor, adapters, fetchJobs, pacingKeyOf } from "./index";

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
