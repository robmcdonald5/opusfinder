import { describe, expect, it } from "vitest";

// prefsFromFlags builds the shared UserPreferences patch from already-string-typed preference flags,
// omitting unset ones. This is also where the module-private assertOrdered (partial, same-invocation
// min<=max guard) is exercised indirectly — assertOrdered is NOT exported, so it's only reachable here.
// Ports scripts/test-prefs-flags.ts to the reporter-owned it/expect idiom.
import { prefsFromFlags } from "../scripts/cli-utils";

describe("prefsFromFlags — location-mode", () => {
  it("valid location-mode parses through", () => {
    expect(prefsFromFlags({ "location-mode": "remote_only" }).locationMode).toBe("remote_only");
  });

  it("bad location-mode throws", () => {
    expect(() => prefsFromFlags({ "location-mode": "bogus" })).toThrow();
  });
});

describe("prefsFromFlags — nullable-int clear sentinel", () => {
  it.each<[string, number | null]>([
    ["clear", null],
    ["", null],
    ["180000", 180000],
  ])("max-salary %j → %j", (value, expected) => {
    expect(prefsFromFlags({ "max-salary": value }).maxSalary).toBe(expected);
  });

  // Falsy-zero is a real value, not "unset": min-yoe "0" must survive as yoeMin === 0.
  it("min-yoe '0' → yoeMin === 0 (falsy-zero survives)", () => {
    expect(prefsFromFlags({ "min-yoe": "0" }).yoeMin).toBe(0);
  });
});

describe("prefsFromFlags — partial min<=max guard (assertOrdered, same-invocation only)", () => {
  it("reversed salary bounds throw", () => {
    expect(() => prefsFromFlags({ "min-salary": "200000", "max-salary": "100000" })).toThrow();
  });

  it("reversed yoe bounds throw", () => {
    expect(() => prefsFromFlags({ "min-yoe": "8", "max-yoe": "2" })).toThrow();
  });

  it("ordered salary bounds pass", () => {
    expect(prefsFromFlags({ "min-salary": "100000", "max-salary": "200000" }).minSalary).toBe(
      100000,
    );
  });

  it("a lone floor passes (no max to compare)", () => {
    expect(prefsFromFlags({ "min-salary": "200000" }).minSalary).toBe(200000);
  });

  it("a cleared floor (null) does not trip the guard", () => {
    expect(prefsFromFlags({ "min-salary": "clear", "max-salary": "100000" }).maxSalary).toBe(
      100000,
    );
  });
});

describe("prefsFromFlags — list fields", () => {
  it("dealbreakers comma-split + trim", () => {
    expect(prefsFromFlags({ dealbreakers: "crypto, on-site" }).dealbreakers).toEqual([
      "crypto",
      "on-site",
    ]);
  });

  it("dealbreakers '' → [] (clears the array)", () => {
    expect(prefsFromFlags({ dealbreakers: "" }).dealbreakers).toEqual([]);
  });

  it("exclusions wired ('a,b' → ['a','b'])", () => {
    expect(prefsFromFlags({ exclusions: "a,b" }).exclusions).toEqual(["a", "b"]);
  });
});

describe("prefsFromFlags — patch shape (unset keys are absent, not undefined-valued)", () => {
  it("no flags → empty patch (0 keys)", () => {
    expect(Object.keys(prefsFromFlags({})).length).toBe(0);
  });

  it("only the passed flag appears; unset bounds are absent", () => {
    const patch = prefsFromFlags({ "min-salary": "5" });
    expect(patch.minSalary).toBe(5);
    expect(patch).not.toHaveProperty("maxSalary");
    expect(patch).not.toHaveProperty("yoeMin");
  });

  it("the retired --remote flag maps to NOTHING (empty patch, so any re-wiring is caught)", () => {
    // Asserting the whole patch is {} (not just absence of a `remoteOk` key the function can never
    // emit) fails if the retired flag is ever re-mapped to a real field.
    expect(prefsFromFlags({ remote: "true" })).toEqual({});
  });
});
