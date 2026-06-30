import { describe, expect, it } from "vitest";

import { mintUserId } from "./userid";

// Golden-vector contract for the must-never-change identity logic. mintUserId is a deterministic
// UUIDv5 over the fixed OPUSFINDER_USER_NS namespace + normalized email; the frozen vector locks the
// bit math, the namespace constant, AND normalization together so any drift fails loudly instead of
// silently re-keying every minted id and orphaning existing user_profiles rows. Ports the identity
// half of scripts/test-userid.ts.

// FROZEN. mintUserId("test@example.com") under the fixed OPUSFINDER_USER_NS namespace.
const GOLDEN_USER_ID = "e101ed0f-2164-5103-a339-e2df142331eb";

describe("mintUserId", () => {
  it("frozen golden vector — locks algorithm + namespace + normalization", () => {
    expect(mintUserId("test@example.com")).toBe(GOLDEN_USER_ID);
  });

  it("is idempotent across case and surrounding whitespace", () => {
    expect(mintUserId("  TEST@Example.com ")).toBe(GOLDEN_USER_ID);
  });

  it("mints the same id for NFC-equivalent (precomposed vs decomposed) emails", () => {
    // Built at runtime (not as source literals) so the intended code points are unambiguous.
    const precomposed = "jos" + String.fromCodePoint(0x00e9) + "@example.com"; // josé (U+00E9)
    const decomposed = "jose" + String.fromCodePoint(0x0301) + "@example.com"; // jose + combining acute
    expect(mintUserId(precomposed)).toBe(mintUserId(decomposed));
  });

  it("mints distinct ids for distinct emails", () => {
    expect(mintUserId("other@example.com")).not.toBe(GOLDEN_USER_ID);
  });

  it("does NOT canonicalize Gmail dots / +tags — kept distinct until real auth resolves identity", () => {
    // Documented intentional non-normalization (only trim/lowercase/NFC happens). Locks that the
    // provider-specific aliasing is deliberately left for auth, not folded in here.
    expect(mintUserId("a.b@gmail.com")).not.toBe(mintUserId("ab@gmail.com"));
    expect(mintUserId("user@gmail.com")).not.toBe(mintUserId("user+tag@gmail.com"));
  });

  it("emits a valid UUIDv5 shape — version nibble 5, RFC 4122 variant 8|9|a|b", () => {
    const id = mintUserId("test@example.com");
    expect(id[14]).toBe("5");
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it.each(["", "   ", "\t\n"])("throws on a blank email (%j)", (email) => {
    expect(() => mintUserId(email)).toThrow();
  });
});
