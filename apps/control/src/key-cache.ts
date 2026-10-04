/**
 * The Access signing-key cache. RUNTIME-NEUTRAL (generic over the key type, clock injected), so its
 * time-dependent policy is unit-tested in the node pool with a fake clock — workerd's clock can't be
 * faked — and the Worker uses it with CryptoKey and Date.now.
 *
 * Policy:
 *   - Keys are fresh for `ttlMs`; a hit within that window never fetches.
 *   - An unknown key id (a rotation) may trigger a refetch, but at most once per `minRefreshMs` of ANY
 *     attempt, so a stream of forged kids can't become a stream of outbound fetches.
 *   - STALE-WHILE-ERROR: when a refetch fails, the last good keys keep verifying tokens (Access keeps a
 *     rotated-out key valid for 7 days) for up to `maxStaleMs` after they were fetched. Past that, or with
 *     nothing cached, the cache reports itself unavailable and the caller fails closed (503).
 *   - BACKOFF: after a failure, no attempt until `backoffBaseMs · 2^(failures−1)` (capped at
 *     `backoffMaxMs`) has passed; a success resets it. Concurrent misses share ONE in-flight fetch.
 */

export class KeysUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeysUnavailableError";
  }
}

export interface KeyCacheOptions<K> {
  load: () => Promise<Map<string, K>>;
  now?: () => number;
  ttlMs?: number;
  minRefreshMs?: number;
  maxStaleMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export class KeyCache<K> {
  private keys: Map<string, K> | null = null;
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private nextAttemptAt = Number.NEGATIVE_INFINITY;
  private failures = 0;
  private inflight: Promise<void> | null = null;

  private readonly load: () => Promise<Map<string, K>>;
  private readonly now: () => number;
  readonly ttlMs: number;
  readonly minRefreshMs: number;
  readonly maxStaleMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;

  constructor(opts: KeyCacheOptions<K>) {
    this.load = opts.load;
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.minRefreshMs = opts.minRefreshMs ?? 30_000;
    this.maxStaleMs = opts.maxStaleMs ?? 24 * 60 * 60_000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 30_000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 10 * 60_000;
  }

  /** The key for `kid`, or null if the (current or last good) key set doesn't have it. */
  async get(kid: string): Promise<K | null> {
    const now = this.now();
    const fresh = this.keys !== null && now - this.fetchedAt < this.ttlMs;
    if (fresh && this.keys?.has(kid)) return this.keys.get(kid) ?? null;

    // Expired, cold, or an unknown kid: refresh — unless backing off, or (keys still fresh) an attempt
    // for an unknown kid already happened within minRefreshMs.
    const allowed =
      now >= this.nextAttemptAt && (!fresh || now - this.lastAttemptAt >= this.minRefreshMs);
    if (allowed || this.inflight) await this.refresh();

    const after = this.now();
    if (this.keys !== null && after - this.fetchedAt < this.maxStaleMs) {
      return this.keys.get(kid) ?? null;
    }
    throw new KeysUnavailableError(
      this.keys === null
        ? "no Access signing keys could be loaded yet"
        : "Access signing keys are too old to trust and could not be refreshed",
    );
  }

  private refresh(): Promise<void> {
    // `.finally` runs as a microtask, i.e. after `inflight` is assigned — so the slot is always cleared,
    // even if load() throws synchronously.
    this.inflight ??= this.attempt().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async attempt(): Promise<void> {
    const started = this.now();
    this.lastAttemptAt = started;
    try {
      this.keys = await this.load();
      this.fetchedAt = started;
      this.failures = 0;
      this.nextAttemptAt = Number.NEGATIVE_INFINITY;
    } catch (err) {
      this.failures++;
      const wait = Math.min(this.backoffBaseMs * 2 ** (this.failures - 1), this.backoffMaxMs);
      this.nextAttemptAt = started + wait;
      // Shape only: the error is about the key endpoint, never a token.
      console.error(
        `Access JWKS refresh failed (${this.failures} in a row; next attempt in ${Math.round(wait / 1000)}s): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}
