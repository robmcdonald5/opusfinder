import { describe, expect, it } from "vitest";

import { generateUnsubscribeToken } from "./index";

// Leaf pure-unit. Locks the unsubscribe-token contract: the RFC 8058 List-Unsubscribe token must be
// URL-safe (lowercase hex → no escaping), carry a full 256 bits of entropy, and be unguessable
// (random, NOT email-derived) + collision-free, so a regression in the RNG/encoding fails loudly
// before a guessable or truncated token ships in a real header. Ports scripts/test-token.ts to the
// reporter-owned idiom.
describe("generateUnsubscribeToken", () => {
  // One batch generated once; the invariant tests below assert over it so a low byte (< 16, which
  // exercises the padStart leading-zero) is overwhelmingly likely to appear — a single call could
  // pass the charset/length checks by luck and hide a dropped pad.
  const N = 2000;
  const batch = Array.from({ length: N }, () => generateUnsubscribeToken());

  it("emits only the URL-safe lowercase-hex charset", () => {
    // No escaping needed when embedded in a List-Unsubscribe URL; uppercase or a non-hex byte would
    // need encoding and is a regression.
    for (const token of batch) expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it("is always 64 hex chars — 32 bytes / 256 bits, every byte zero-padded to 2", () => {
    // Guards the padStart(2, "0"): a byte < 16 must still render 2 chars, so the length never drifts.
    for (const token of batch) expect(token).toHaveLength(64);
  });

  it("is distinct across calls (random, not a constant)", () => {
    expect(generateUnsubscribeToken()).not.toBe(generateUnsubscribeToken());
  });

  it("has no collisions across a batch — sanity on the RNG source", () => {
    // A broken/constant source collapses the Set; ~2k iterations keeps the unit fast while still
    // exercising the randomness. The full 10k bench lives in the opt-in skip below.
    const seen = new Set(batch);
    expect(seen.size).toBe(N);
  });

  // Opt-in throughput/collision bench — matches the original 10k-iteration script loop. Skipped by
  // default to keep the leaf unit fast; un-skip to stress the RNG over a larger batch.
  it.skip("has no collisions across 10k (bench)", () => {
    const BENCH = 10000;
    const seen = new Set<string>();
    for (let i = 0; i < BENCH; i++) seen.add(generateUnsubscribeToken());
    expect(seen.size).toBe(BENCH);
  });
});
