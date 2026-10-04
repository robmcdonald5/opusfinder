import { afterEach, describe, expect, it, vi } from "vitest";

import { KeyCache, KeysUnavailableError } from "./key-cache";

// The signing-key cache's time-dependent policy, with an injected clock (workerd's clock can't be faked,
// so the Miniflare suite covers the paths that need no time to pass: cold-start failure + backoff, and
// the unknown-kid rate limit). Keys are plain strings here; the Worker uses CryptoKey.

const MIN = 60_000;

function rig(opts: { failing?: boolean } = {}) {
  let now = 1_000_000;
  let failing = opts.failing ?? false;
  let keyset = new Map([["k1", "key-one"]]);
  const load = vi.fn(async () => {
    if (failing) throw new Error("HTTP 503");
    return new Map(keyset);
  });
  const cache = new KeyCache<string>({ load, now: () => now });
  return {
    cache,
    load,
    advance: (ms: number) => {
      now += ms;
    },
    fail: (f: boolean) => {
      failing = f;
    },
    rotate: (next: Record<string, string>) => {
      keyset = new Map(Object.entries(next));
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("KeyCache", () => {
  it("serves a fresh hit without fetching", async () => {
    const r = rig();
    expect(await r.cache.get("k1")).toBe("key-one");
    r.advance(5 * MIN);
    expect(await r.cache.get("k1")).toBe("key-one");
    expect(r.load).toHaveBeenCalledTimes(1);
  });

  it("refetches after the TTL", async () => {
    const r = rig();
    await r.cache.get("k1");
    r.advance(r.cache.ttlMs);
    await r.cache.get("k1");
    expect(r.load).toHaveBeenCalledTimes(2);
  });

  it("keeps serving the last good keys when a refetch fails (stale-while-error)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = rig();
    await r.cache.get("k1");
    r.fail(true);
    r.advance(r.cache.ttlMs + 1);
    expect(await r.cache.get("k1")).toBe("key-one");
    expect(r.load).toHaveBeenCalledTimes(2);
  });

  it("backs off after a failure instead of refetching on every request, exponentially, capped", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = rig();
    await r.cache.get("k1");
    r.fail(true);
    r.advance(r.cache.ttlMs + 1);
    await r.cache.get("k1"); // attempt 1 fails → wait backoffBase (30 s)
    for (let i = 0; i < 20; i++) expect(await r.cache.get("k1")).toBe("key-one");
    expect(r.load).toHaveBeenCalledTimes(2);

    r.advance(r.cache.backoffBaseMs); // attempt 2 fails → wait 60 s
    await r.cache.get("k1");
    expect(r.load).toHaveBeenCalledTimes(3);
    r.advance(r.cache.backoffBaseMs);
    await r.cache.get("k1"); // only 30 s of the 60 s passed: no attempt
    expect(r.load).toHaveBeenCalledTimes(3);
    r.advance(r.cache.backoffBaseMs);
    await r.cache.get("k1");
    expect(r.load).toHaveBeenCalledTimes(4);

    // Many failures later the wait is capped at backoffMax.
    for (let i = 0; i < 10; i++) {
      r.advance(r.cache.backoffMaxMs);
      await r.cache.get("k1");
    }
    const calls = r.load.mock.calls.length;
    r.advance(r.cache.backoffMaxMs);
    await r.cache.get("k1");
    expect(r.load.mock.calls.length).toBe(calls + 1);
  });

  it("recovers and resets the backoff once the endpoint is back", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = rig();
    await r.cache.get("k1");
    r.fail(true);
    r.advance(r.cache.ttlMs + 1);
    await r.cache.get("k1");
    r.fail(false);
    r.rotate({ k2: "key-two" });
    r.advance(r.cache.backoffBaseMs);
    expect(await r.cache.get("k2")).toBe("key-two");
    expect(await r.cache.get("k1")).toBeNull(); // rotated out of the fresh set
  });

  it("stops trusting stale keys after maxStale and fails closed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = rig();
    await r.cache.get("k1");
    r.fail(true);
    r.advance(r.cache.maxStaleMs);
    await expect(r.cache.get("k1")).rejects.toBeInstanceOf(KeysUnavailableError);
  });

  it("fails closed on a cold start with the endpoint down — and backs off from there too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = rig({ failing: true });
    for (let i = 0; i < 5; i++) {
      await expect(r.cache.get("k1")).rejects.toBeInstanceOf(KeysUnavailableError);
    }
    expect(r.load).toHaveBeenCalledTimes(1);
  });

  it("rate-limits refetches for unknown kids while the keys are fresh", async () => {
    const r = rig();
    await r.cache.get("k1");
    r.advance(r.cache.minRefreshMs);
    for (let i = 0; i < 10; i++) expect(await r.cache.get(`forged-${i}`)).toBeNull();
    expect(r.load).toHaveBeenCalledTimes(2);
    r.advance(r.cache.minRefreshMs);
    r.rotate({ k1: "key-one", k3: "key-three" });
    expect(await r.cache.get("k3")).toBe("key-three");
    expect(r.load).toHaveBeenCalledTimes(3);
  });

  it("shares one in-flight fetch between concurrent misses", async () => {
    const r = rig();
    const results = await Promise.all(Array.from({ length: 10 }, () => r.cache.get("k1")));
    expect(new Set(results)).toEqual(new Set(["key-one"]));
    expect(r.load).toHaveBeenCalledTimes(1);
  });

  it("never wedges when load() throws synchronously", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let now = 0;
    let calls = 0;
    const cache = new KeyCache<string>({
      now: () => now,
      load: () => {
        calls++;
        if (calls === 1) throw new Error("sync throw");
        return Promise.resolve(new Map([["k1", "key-one"]]));
      },
    });
    await expect(cache.get("k1")).rejects.toBeInstanceOf(KeysUnavailableError);
    now += cache.backoffBaseMs;
    expect(await cache.get("k1")).toBe("key-one");
  });
});
