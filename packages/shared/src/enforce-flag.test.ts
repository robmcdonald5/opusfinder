import { describe, expect, it } from "vitest";

import { parseEnforceFlag } from "./index";

// Phase 0 pilot — leaf pure-unit (no workspace deps). Locks which strings enable the lifecycle 'closed'
// write: exactly the explicit affirmatives enforce; the safe/default values (shadow/""/undefined) stay
// off, so a regression can't silently start closing jobs in production. Ports scripts/test-enforce-flag.ts
// to the reporter-owned `it.each` idiom.
describe("parseEnforceFlag", () => {
  it.each(["enforce", "ENFORCE", "  Enforce ", "true", "1", "on", "yes", "YES"])(
    "%j → enforce (true)",
    (value) => {
      expect(parseEnforceFlag(value)).toBe(true);
    },
  );

  it.each(["shadow", "off", "", "  ", "false", "0", "no", "enforced", "enabletrue"])(
    "%j → shadow (false) — the load-bearing default-safety cases",
    (value) => {
      expect(parseEnforceFlag(value)).toBe(false);
    },
  );

  it("undefined → shadow (the unset default)", () => {
    expect(parseEnforceFlag(undefined)).toBe(false);
  });
});
