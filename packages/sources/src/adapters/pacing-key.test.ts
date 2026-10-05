import { describe, expect, it } from "vitest";

import { SOURCE_NAMES, adapters, pacingKeyOf } from "./index";

// Leaf pure-unit: ingestion paces boards per PACING KEY (runIngestion's paceMs). Every registered
// adapter must resolve one — declared (`pacingKey`) or defaulted (its source) — and the defaults encode
// the host audit in types.ts: no two adapters share a request host today, so each paces alone. Adding a
// shared-host adapter means declaring a shared key AND updating the audit expectation below.
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
