import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostThrottle } from "./probe";

// Leaf pure-unit for the per-host politeness gate that `probeCandidates` runs behind. Two invariants
// compose: (1) at most `concurrency` probes in flight per host, and (2) at least `minIntervalMs`
// between two STARTS to the same host — while DISTINCT hosts are never gated against each other.
// The gate polls on a REAL setTimeout (sleep), so timers are FAKE and driven with the ASYNC advance
// api. To observe a still-blocked acquire without awaiting it, a `done` flag is flipped in `.then()`
// and asserted after a microtask flush. Date.now() is faked in lockstep with the timers (no Date
// override); the base is pinned so the FIRST acquire (lastStart defaults to 0) is always past the
// interval and resolves immediately.

// Mirrors probe.ts THROTTLE_POLL_MS — the concurrency gate re-checks on this cadence.
const THROTTLE_POLL_MS = 25;
// A base far past 0 so a fresh host's `sinceStart` (now - lastStart:0) clears any minIntervalMs.
const BASE_TIME = 1_000_000;

describe("HostThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spaces two same-host STARTS by at least minIntervalMs", async () => {
    const t = new HostThrottle(4, 500);
    const host = "boards-api.greenhouse.io";

    await t.acquire(host); // first start: immediate

    let done = false;
    const p = t.acquire(host).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false); // blocked by the 500ms min-interval

    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false); // still inside the interval

    await vi.advanceTimersByTimeAsync(1); // crosses 500ms
    await p;
    expect(done).toBe(true);
  });

  it("caps concurrency per host; a 3rd acquire waits for a release", async () => {
    const t = new HostThrottle(2, 0); // interval disabled: isolate the concurrency cap
    const host = "api.smartrecruiters.com";

    await t.acquire(host);
    await t.acquire(host); // 2 in flight == cap

    let done = false;
    const p = t.acquire(host).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false); // at the cap

    await vi.advanceTimersByTimeAsync(THROTTLE_POLL_MS); // a poll with NO release: still blocked
    expect(done).toBe(false);

    t.release(host); // frees a slot
    await vi.advanceTimersByTimeAsync(THROTTLE_POLL_MS); // next poll sees it
    await p;
    expect(done).toBe(true);
  });

  it("release() decrements in-flight so a blocked acquire proceeds", async () => {
    const t = new HostThrottle(1, 0);
    const host = "one.example.com";

    await t.acquire(host); // 1 in flight == cap

    let done = false;
    const p = t.acquire(host).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);

    t.release(host); // in-flight → 0
    await vi.advanceTimersByTimeAsync(THROTTLE_POLL_MS);
    await p;
    expect(done).toBe(true);
  });

  it("does NOT gate distinct hosts against each other", async () => {
    const t = new HostThrottle(1, 500); // tight cap + interval, but per-host

    let doneA = false;
    let doneB = false;
    const pa = t.acquire("hostA").then(() => {
      doneA = true;
    });
    const pb = t.acquire("hostB").then(() => {
      doneB = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.all([pa, pb]);

    expect(doneA).toBe(true);
    expect(doneB).toBe(true);
  });
});
