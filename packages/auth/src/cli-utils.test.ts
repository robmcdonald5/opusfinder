import { describe, expect, it } from "vitest";

// cli-utils lives in scripts/ (not in the package exports map), so import via the relative path.
// These are the standalone argv-parsing helpers shared by the user-management CLIs: pure
// string→coerced-value validators that throw an actionable, secret-free error on bad input.
// Ports the parser-level assertions that back scripts/test-prefs-flags.ts (prefsFromFlags coverage
// lives in the sibling prefs-flags.test.ts).
import {
  maskEmail,
  parseBool,
  parseCadence,
  parseIntFlag,
  parseList,
  parseLocationMode,
  parseNullableInt,
} from "../scripts/cli-utils";

describe("parseBool", () => {
  it("'true' → true", () => {
    expect(parseBool("true", "enabled")).toBe(true);
  });

  it("'false' → false", () => {
    expect(parseBool("false", "enabled")).toBe(false);
  });

  // Case-sensitive, literal match only: near-misses (yes/True/1) all throw.
  it.each(["yes", "True", "1"])("%j throws (not a bare true/false)", (value) => {
    expect(() => parseBool(value, "enabled")).toThrow(/--enabled must be "true" or "false"/);
  });
});

describe("parseIntFlag", () => {
  it("parses a valid integer string", () => {
    expect(parseIntFlag("42", "recency-days")).toBe(42);
  });

  it.each(["1.5", "abc", "", "  ", "0x10", "1e3", "-3"])("%j throws", (value) => {
    expect(() => parseIntFlag(value, "min-yoe")).toThrow(
      /--min-yoe must be a non-negative integer/,
    );
  });
});

describe("parseCadence", () => {
  it.each(["daily", "weekly", "monthly"])("%j → itself", (value) => {
    expect(parseCadence(value)).toBe(value);
  });

  it("unknown cadence throws", () => {
    expect(() => parseCadence("yearly")).toThrow(/--cadence must be one of/);
  });
});

describe("parseLocationMode", () => {
  it.each(["any", "remote_only", "onsite_only"])("%j → itself", (value) => {
    expect(parseLocationMode(value)).toBe(value);
  });

  it("'hybrid' throws", () => {
    expect(() => parseLocationMode("hybrid")).toThrow(/--location-mode must be one of/);
  });
});

describe("parseNullableInt", () => {
  it.each<[string, number | null]>([
    ["clear", null],
    ["", null],
    ["180000", 180000],
  ])("%j → %j", (value, expected) => {
    expect(parseNullableInt(value, "max-salary")).toBe(expected);
  });

  it("invalid non-empty input throws", () => {
    expect(() => parseNullableInt("abc", "max-salary")).toThrow(
      /--max-salary must be a non-negative integer/,
    );
  });
});

describe("parseList", () => {
  it.each<[string, string[]]>([
    ["crypto, on-site", ["crypto", "on-site"]],
    ["", []],
    ["a,,b", ["a", "b"]],
    ["   ", []],
  ])("%j → %j", (value, expected) => {
    expect(parseList(value)).toEqual(expected);
  });
});

describe("maskEmail", () => {
  it.each<[string, string]>([
    ["jane@example.com", "j***e@example.com"],
    ["a@b.com", "a***@b.com"],
    ["", "***"],
    ["@x.com", "***"],
  ])("%j → %j", (email, masked) => {
    expect(maskEmail(email)).toBe(masked);
  });
});
