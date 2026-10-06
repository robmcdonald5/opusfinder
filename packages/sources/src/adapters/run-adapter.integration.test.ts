import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { companySlug, jobId, type NormalizedJob, type SourceName } from "@opusfinder/shared";
import { server } from "@test/msw/server";
import { rejectionOf } from "@test/rejection";

import { HttpStatusError, runAdapter } from "./run-adapter";
import type { SourceAdapter, SourceContext } from "./types";

// The invariant ATS plumbing (run-adapter.ts) over MSW: the pagination loop, the resilient fetch
// (retry/backoff/Retry-After + non-JSON guard), two-tier resilience (locate LOUD, mapItem SOFT),
// the maxItems cap, and the bounded-concurrency hydrate pool. runAdapter reaches the network via the
// GLOBAL fetch, so MSW intercepts every request — the wire-shape checks (URL, method, the cursor
// threaded into each page request) are exactly what the URL-only fetch-router in the Phase-2
// runIngestion suite cannot assert. onUnhandledRequest:"error" (the integration setup) proves zero
// live egress: any host these handlers don't cover fails the test loudly.
//
// Timing note: `backoff` sleeps a hardcoded 2s base (+ jitter) with no injectable seam, so retry
// tests pin `Retry-After: 0` (→ ~0-250 ms real sleep) instead of faking timers. The one exception is
// the network-error retry (a rejected fetch carries no Retry-After header, so its backoff is the full
// 2s base) — that single test uses fake timers to advance the known delay deterministically.
// Non-2xx handlers return `new HttpResponse(null, ...)`: runAdapter's non-ok branch calls
// `res.body?.cancel()`, and cancelling an MSW-mocked body deadlocks — a null body skips the optional
// chain (the body-drain matters only on a real socket, a live-gate concern).

const HOST = "https://ats.test.example/boards/acme";
const LIST = `${HOST}/jobs`;
const DETAIL = `${HOST}/detail`; // hydrate's second fetch (distinct path from LIST)
const SOURCE: SourceName = "greenhouse";

interface RawItem {
  id: number;
  title?: string;
  locations?: string[];
}
function raw(id: number, extra: Partial<RawItem> = {}): RawItem {
  return { id, ...extra };
}

/** A minimal, fully-valid NormalizedJob — runAdapter only reads `.locations` (it sorts it); the rest
 *  is carried through so the returned shape and hydrate merges are asserted realistically. */
function mkJob(item: RawItem, ctx: SourceContext): NormalizedJob {
  return {
    source: SOURCE,
    externalId: jobId(String(item.id)),
    title: item.title ?? `Job ${item.id}`,
    companySlug: ctx.slug,
    locations: item.locations ?? [],
    remote: false,
    descriptionText: "",
    applyUrl: `https://x/${item.id}`,
    postedAt: null,
  };
}

/** A greenhouse-flavored adapter with every method overridable per test. Defaults: single unpaginated
 *  GET of LIST, `{ jobs: [...] }` envelope, one job per item. */
function makeAdapter(over: Partial<SourceAdapter> = {}): SourceAdapter {
  return {
    source: SOURCE,
    normalizeSlug: (rawSlug) => companySlug(rawSlug),
    matchUrl: () => null,
    jobsRequest: () => ({ url: LIST }),
    locate: (body) => (body as { jobs: unknown[] }).jobs,
    mapItem: (item, ctx) => mkJob(item as RawItem, ctx),
    ...over,
  };
}

const ids = (jobs: NormalizedJob[]): string[] => jobs.map((j) => j.externalId as string);

describe("runAdapter — invariant ATS plumbing over MSW", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("request contract + single fetch", () => {
    it("builds the request from jobsRequest, maps each item, and sorts each job's locations without mutating the raw input", async () => {
      let method = "";
      let url = "";
      server.use(
        http.get(LIST, ({ request }) => {
          method = request.method;
          url = request.url;
          return HttpResponse.json({ jobs: [raw(1, { locations: ["Zeta", "Alpha"] }), raw(2)] });
        }),
      );
      const items: RawItem[] = [];
      const adapter = makeAdapter({
        mapItem: (item, ctx) => {
          items.push(item as RawItem);
          return mkJob(item as RawItem, ctx);
        },
      });

      const jobs = await runAdapter(adapter, "acme");

      expect(method).toBe("GET");
      expect(url).toBe(LIST);
      expect(ids(jobs)).toEqual(["1", "2"]);
      // runAdapter canonicalizes location order (keeps the persisted jsonb stable) — ["Zeta","Alpha"] → sorted.
      expect(jobs[0]?.locations).toEqual(["Alpha", "Zeta"]);
      // The sort must COPY: mkJob aliases job.locations to the raw item's array, and that raw item is what a
      // hydrate is handed. An in-place `.sort()` would reorder the raw item too — assert it didn't.
      expect(items[0]?.locations).toEqual(["Zeta", "Alpha"]);
    });

    it("normalizes the raw slug into ctx.slug before mapping (never passes rawSlug through)", async () => {
      server.use(http.get(LIST, () => HttpResponse.json({ jobs: [raw(1)] })));
      // normalizeSlug transforms the raw input; a regression that used rawSlug directly as ctx.slug would
      // persist postings under a non-canonical company key, silently breaking cross-source dedupe/grouping.
      const adapter = makeAdapter({
        normalizeSlug: (rawSlug) => companySlug(rawSlug.replace("-RAW", "")),
      });

      const jobs = await runAdapter(adapter, "acme-RAW");

      expect(jobs[0]?.companySlug).toBe(companySlug("acme")); // the normalized slug, NOT companySlug("acme-RAW")
    });
  });

  describe("pagination", () => {
    it("threads the cursor through each page request, stops when nextCursor returns null, and accumulates in order", async () => {
      // pageSize 2: offset 0 → [1,2], offset 2 → [3,4], offset 4 → [] (empty → nextCursor null → stop).
      const pages: RawItem[][] = [[raw(1), raw(2)], [raw(3), raw(4)], []];
      const offsetsSeen: (string | null)[] = [];
      server.use(
        http.get(LIST, ({ request }) => {
          const offsetParam = new URL(request.url).searchParams.get("offset");
          offsetsSeen.push(offsetParam);
          const page = Number(offsetParam ?? "0") / 2;
          return HttpResponse.json({ jobs: pages[page] ?? [] });
        }),
      );

      const pageItemCounts: number[] = [];
      const adapter = makeAdapter({
        jobsRequest: (_ctx, cursor) => ({
          url: cursor ? `${LIST}?offset=${cursor.offset}` : LIST,
        }),
        nextCursor: (_body, prev, count) => {
          pageItemCounts.push(count);
          return count > 0 ? { kind: "offset", offset: (prev?.offset ?? 0) + count } : null;
        },
      });

      const jobs = await runAdapter(adapter, "acme");

      expect(offsetsSeen).toEqual([null, "2", "4"]); // page 0 sends no offset; each next page carries the threaded cursor
      expect(pageItemCounts).toEqual([2, 2, 0]); // nextCursor receives each page's real item count
      expect(ids(jobs)).toEqual(["1", "2", "3", "4"]); // every page accumulated, in order
    });

    it("omitting nextCursor does a single unpaginated fetch even when the body looks paginated", async () => {
      let calls = 0;
      server.use(
        http.get(LIST, () => {
          calls += 1;
          return HttpResponse.json({ jobs: [raw(1), raw(2)], hasMore: true, nextOffset: 2 });
        }),
      );

      const jobs = await runAdapter(makeAdapter(), "acme"); // default adapter has no nextCursor

      expect(calls).toBe(1);
      expect(ids(jobs)).toEqual(["1", "2"]);
    });
  });

  describe("maxItems cap (partial fetch)", () => {
    it("caps mapped postings on a single page, trimming the tail and never paginating", async () => {
      const offsetsSeen: (string | null)[] = [];
      server.use(
        http.get(LIST, ({ request }) => {
          const offset = new URL(request.url).searchParams.get("offset");
          offsetsSeen.push(offset);
          // Items only on page 0; a later page returns [] so a BROKEN cap (one that keeps paginating)
          // terminates cleanly on the empty page — asserted via offsetsSeen — instead of looping
          // forever on a repeating body (which would OOM the worker rather than fail an assertion).
          return HttpResponse.json({
            jobs: offset === null ? [raw(1), raw(2), raw(3), raw(4), raw(5)] : [],
          });
        }),
      );
      // The adapter WOULD paginate (nextCursor always advances), so a broken cap would fetch page 2.
      const adapter = makeAdapter({
        jobsRequest: (_ctx, cursor) => ({ url: cursor ? `${LIST}?offset=${cursor.offset}` : LIST }),
        nextCursor: (_body, prev, count) =>
          count > 0 ? { kind: "offset", offset: (prev?.offset ?? 0) + count } : null,
      });

      const jobs = await runAdapter(adapter, "acme", { maxItems: 3 });

      expect(ids(jobs)).toEqual(["1", "2", "3"]); // trimmed to the first 3
      expect(offsetsSeen).toEqual([null]); // pagination stopped — page 2 (offset 5) never requested
    });

    it("caps across pages, stopping the moment the cap is reached at a page boundary", async () => {
      // pageSize 2, cap 3: page 0 [1,2] (len 2 < 3) → page 1 [3,4] (len 4 ≥ 3) → trim to 3, break.
      const pages: RawItem[][] = [[raw(1), raw(2)], [raw(3), raw(4)], [raw(5), raw(6)]];
      const offsetsSeen: (string | null)[] = [];
      server.use(
        http.get(LIST, ({ request }) => {
          const offsetParam = new URL(request.url).searchParams.get("offset");
          offsetsSeen.push(offsetParam);
          return HttpResponse.json({ jobs: pages[Number(offsetParam ?? "0") / 2] ?? [] });
        }),
      );
      const adapter = makeAdapter({
        jobsRequest: (_ctx, cursor) => ({ url: cursor ? `${LIST}?offset=${cursor.offset}` : LIST }),
        nextCursor: (_body, prev, count) =>
          count > 0 ? { kind: "offset", offset: (prev?.offset ?? 0) + count } : null,
      });

      const jobs = await runAdapter(adapter, "acme", { maxItems: 3 });

      expect(ids(jobs)).toEqual(["1", "2", "3"]);
      expect(offsetsSeen).toEqual([null, "2"]); // page 2 (offset 4) never fetched — cap hit on page 1
    });

    it("bounds the hydrate pool to the capped set (the trim happens BEFORE hydrate)", async () => {
      let hydrateCalls = 0;
      server.use(
        http.get(LIST, () =>
          HttpResponse.json({ jobs: [raw(1), raw(2), raw(3), raw(4), raw(5)] }),
        ),
      );
      const adapter = makeAdapter({
        hydrate: (job) => {
          hydrateCalls += 1;
          return Promise.resolve({ descriptionText: `h-${job.externalId}` });
        },
      });

      const jobs = await runAdapter(adapter, "acme", { maxItems: 2 });

      expect(jobs).toHaveLength(2);
      expect(hydrateCalls).toBe(2); // NOT 5 — hydrate never touches the trimmed-away items
    });
  });

  describe("resilient fetch — retry / backoff", () => {
    it("retries a transient 503 (Retry-After: 0) and succeeds on the next attempt", async () => {
      let calls = 0;
      server.use(
        http.get(LIST, () => {
          calls += 1;
          if (calls === 1) {
            return new HttpResponse(null, { status: 503, headers: { "retry-after": "0" } });
          }
          return HttpResponse.json({ jobs: [raw(1)] });
        }),
      );

      const jobs = await runAdapter(makeAdapter(), "acme");

      expect(calls).toBe(2);
      expect(ids(jobs)).toEqual(["1"]);
    });

    it("retries a transient 429 (Retry-After: 0) and succeeds — a rate-limit is recoverable, not a dropped board", async () => {
      // Distinct from the 5xx term above: this pins the `res.status === 429` half of the retryable set
      // (the code cites Workable's HTML 429). Dropping just that clause would turn a recoverable rate-limit
      // into a board dropped on its first hit.
      let calls = 0;
      server.use(
        http.get(LIST, () => {
          calls += 1;
          if (calls === 1) {
            return new HttpResponse(null, { status: 429, headers: { "retry-after": "0" } });
          }
          return HttpResponse.json({ jobs: [raw(1)] });
        }),
      );

      const jobs = await runAdapter(makeAdapter(), "acme");

      expect(calls).toBe(2);
      expect(ids(jobs)).toEqual(["1"]);
    });

    it("aborts a hung request via fetchTimeoutMs and surfaces it as a tagged fetch-error", async () => {
      // run-adapter's most safety-critical invariant (its own doc comment): a board that accepts the
      // connection but never responds would otherwise hang the whole Worker tick forever, freezing the KV
      // chunk cursor. AbortSignal.timeout converts that hang into an ordinary transient failure. Fake timers
      // fire the timeout deterministically; the never-resolving handler means ONLY the abort can settle the fetch.
      vi.useFakeTimers();
      try {
        let calls = 0;
        server.use(
          http.get(LIST, () => {
            calls += 1;
            return new Promise<never>(() => {}); // never resolves
          }),
        );

        const promise = runAdapter(makeAdapter(), "acme", { maxRetries: 0, fetchTimeoutMs: 50 });
        const settled = expect(promise).rejects.toThrow(/greenhouse "acme" fetch error:/);
        await vi.advanceTimersByTimeAsync(100); // past fetchTimeoutMs → the timeout signal aborts the fetch
        await settled;

        expect(calls).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("retries up to maxRetries then throws a tagged fetch-failed error", async () => {
      let calls = 0;
      server.use(
        http.get(LIST, () => {
          calls += 1;
          return new HttpResponse(null, { status: 503, headers: { "retry-after": "0" } });
        }),
      );

      await expect(runAdapter(makeAdapter(), "acme", { maxRetries: 1 })).rejects.toThrow(
        /greenhouse "acme" fetch failed: 503/,
      );
      expect(calls).toBe(2); // 1 initial + 1 retry
    });

    it("a 429 that outlasts its retries rejects with a typed HttpStatusError carrying status 429", async () => {
      // runIngestion's rate-limit breaker branches on this typed status, never on the message.
      let calls = 0;
      server.use(
        http.get(LIST, () => {
          calls += 1;
          return new HttpResponse(null, { status: 429, headers: { "retry-after": "0" } });
        }),
      );

      const err = await rejectionOf(runAdapter(makeAdapter(), "acme", { maxRetries: 1 }));

      expect(err).toBeInstanceOf(HttpStatusError);
      expect((err as HttpStatusError).status).toBe(429);
      expect(err.message).toMatch(/^greenhouse "acme" fetch failed: 429/);
      expect(calls).toBe(2); // the retry ran first: the error is the board's final outcome
    });

    it("does NOT retry a non-retryable 4xx — one request, then throws", async () => {
      let calls = 0;
      server.use(
        http.get(LIST, () => {
          calls += 1;
          return new HttpResponse(null, { status: 404 });
        }),
      );

      await expect(runAdapter(makeAdapter(), "acme", { maxRetries: 3 })).rejects.toThrow(
        /greenhouse "acme" fetch failed: 404/,
      );
      expect(calls).toBe(1);
    });

    it("recovers from a non-JSON 2xx body by retrying", async () => {
      // A bad body on a 2xx carries no Retry-After, so the parse-retry backoff is the full 2s base
      // (+ jitter). Fake timers advance that known delay deterministically (see the network-error test).
      vi.useFakeTimers();
      try {
        let calls = 0;
        server.use(
          http.get(LIST, () => {
            calls += 1;
            if (calls === 1) return HttpResponse.text("<html>not json</html>"); // 200, unparseable
            return HttpResponse.json({ jobs: [raw(1)] });
          }),
        );

        const promise = runAdapter(makeAdapter(), "acme");
        await vi.advanceTimersByTimeAsync(2500);

        await expect(promise).resolves.toHaveLength(1);
        expect(calls).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("throws the non-JSON error after exhausting retries on a persistent bad 2xx body", async () => {
      vi.useFakeTimers();
      try {
        let calls = 0;
        server.use(
          http.get(LIST, () => {
            calls += 1;
            return HttpResponse.text("<html>still not json</html>");
          }),
        );

        const promise = runAdapter(makeAdapter(), "acme", { maxRetries: 1 });
        const settled = expect(promise).rejects.toThrow(
          /greenhouse "acme" returned a non-JSON body \(status 200\)/,
        );
        await vi.advanceTimersByTimeAsync(2500);
        await settled;

        expect(calls).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("throws a tagged fetch-error on a network failure with no retries left", async () => {
      let calls = 0;
      server.use(
        http.get(LIST, () => {
          calls += 1;
          return HttpResponse.error(); // rejects the fetch (network error)
        }),
      );

      await expect(runAdapter(makeAdapter(), "acme", { maxRetries: 0 })).rejects.toThrow(
        /greenhouse "acme" fetch error:/,
      );
      expect(calls).toBe(1); // maxRetries 0 → no backoff, immediate throw
    });

    it("retries a network error (fetch rejects) and recovers on the next attempt", async () => {
      // A rejected fetch has no Retry-After, so its backoff is the full 2s base (+ jitter). Fake timers
      // advance that known delay deterministically instead of sleeping 2s of wall-clock.
      vi.useFakeTimers();
      try {
        let calls = 0;
        server.use(
          http.get(LIST, () => {
            calls += 1;
            return calls === 1 ? HttpResponse.error() : HttpResponse.json({ jobs: [raw(1)] });
          }),
        );

        const promise = runAdapter(makeAdapter(), "acme", { maxRetries: 1 });
        await vi.advanceTimersByTimeAsync(2500); // past base 2000ms + up to 250ms jitter

        await expect(promise).resolves.toHaveLength(1);
        expect(calls).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("two-tier resilience — locate LOUD, mapItem SOFT", () => {
    it("propagates a locate throw (a bad envelope fails the board loud)", async () => {
      server.use(http.get(LIST, () => HttpResponse.json({ wrong: "shape" })));
      const adapter = makeAdapter({
        locate: () => {
          throw new Error("bad envelope");
        },
      });

      await expect(runAdapter(adapter, "acme")).rejects.toThrow(/bad envelope/);
    });

    it("skips an item whose mapItem returns null and continues the board", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      server.use(http.get(LIST, () => HttpResponse.json({ jobs: [raw(1), raw(2), raw(3)] })));
      const adapter = makeAdapter({
        mapItem: (item, ctx) => {
          const r = item as RawItem;
          return r.id === 2 ? null : mkJob(r, ctx);
        },
      });

      const jobs = await runAdapter(adapter, "acme");

      expect(ids(jobs)).toEqual(["1", "3"]); // the null-mapped middle item is skipped, order preserved
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/skipped 1 malformed/));
    });

    it("skips an item whose mapItem THROWS (soft failure never aborts the board)", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      server.use(http.get(LIST, () => HttpResponse.json({ jobs: [raw(1), raw(2), raw(3)] })));
      const adapter = makeAdapter({
        mapItem: (item, ctx) => {
          const r = item as RawItem;
          if (r.id === 2) throw new Error("branding-floor violation");
          return mkJob(r, ctx);
        },
      });

      const jobs = await runAdapter(adapter, "acme");

      expect(ids(jobs)).toEqual(["1", "3"]);
    });
  });

  describe("hydrate pool", () => {
    it("merges each hydrate patch onto its mapped job, preserving un-patched fields", async () => {
      server.use(http.get(LIST, () => HttpResponse.json({ jobs: [raw(1), raw(2)] })));
      const adapter = makeAdapter({
        hydrate: (job) => Promise.resolve({ descriptionText: `desc-${job.externalId}` }),
      });

      const jobs = await runAdapter(adapter, "acme");

      expect(jobs.map((j) => j.descriptionText)).toEqual(["desc-1", "desc-2"]);
      expect(jobs[0]?.applyUrl).toBe("https://x/1"); // base field untouched by the merge
    });

    it("preserves input order even when hydrate resolves out of order", async () => {
      server.use(http.get(LIST, () => HttpResponse.json({ jobs: [raw(1), raw(2), raw(3)] })));
      const releases: Array<() => void> = [];
      const adapter = makeAdapter({
        hydrate: (job) =>
          new Promise<Partial<NormalizedJob>>((resolve) => {
            releases.push(() => resolve({ descriptionText: `h-${job.externalId}` }));
          }),
      });

      const promise = runAdapter(adapter, "acme", { hydrateConcurrency: 3 });
      await vi.waitFor(() => expect(releases).toHaveLength(3)); // all 3 hydrate calls pending
      [...releases].reverse().forEach((release) => release()); // complete in REVERSE of input order

      const jobs = await promise;
      expect(ids(jobs)).toEqual(["1", "2", "3"]); // mapWithConcurrency writes results by index
      expect(jobs.map((j) => j.descriptionText)).toEqual(["h-1", "h-2", "h-3"]);
    });

    it("keeps the listed job when ITS hydrate throws, flagged contentMissing (per-item failure isolation)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      server.use(http.get(LIST, () => HttpResponse.json({ jobs: [raw(1), raw(2), raw(3)] })));
      const adapter = makeAdapter({
        hydrate: (job) => {
          if (job.externalId === jobId("2")) return Promise.reject(new Error("detail 500"));
          return Promise.resolve({ descriptionText: `desc-${job.externalId}` });
        },
      });

      const jobs = await runAdapter(adapter, "acme");

      // Item 2 is still returned — it was LISTED, so it is live and ingestion must count it present — but its
      // "" is mapItem's placeholder, not content: the flag is what stops upsertJobs writing it over the stored
      // description. Only the failed item is flagged; the hydrated ones carry no flag at all.
      expect(jobs.map((j) => j.descriptionText)).toEqual(["desc-1", "", "desc-3"]);
      expect(jobs.map((j) => j.contentMissing)).toEqual([undefined, true, undefined]);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/1 un-hydrated/));
    });

    it("hands each hydrate ITS OWN raw list item, and returns jobs that carry no raw", async () => {
      const items = [raw(1, { title: "one" }), raw(2, { title: "two" })];
      server.use(http.get(LIST, () => HttpResponse.json({ jobs: items })));
      const seen: unknown[] = [];
      const adapter = makeAdapter({
        hydrate: (job, item) => {
          seen.push(item);
          return Promise.resolve({ descriptionText: `desc-${job.externalId}` });
        },
      });

      const jobs = await runAdapter(adapter, "acme", { hydrateConcurrency: 1 });

      // The list item rides to hydrate as its own argument (the job has no raw to read it from) — the
      // parsed item for THAT posting, not another posting's, not undefined.
      expect(seen).toEqual(items);
      // jobs.raw is not stored, so the returned jobs don't carry the source object either.
      for (const job of jobs) expect(job).not.toHaveProperty("raw");
    });

    it("bounds concurrent hydrate calls to hydrateConcurrency", async () => {
      server.use(
        http.get(LIST, () =>
          HttpResponse.json({ jobs: [raw(1), raw(2), raw(3), raw(4), raw(5)] }),
        ),
        http.get(`${DETAIL}/:id`, () => HttpResponse.json({ ok: true })),
      );
      let inFlight = 0;
      let peak = 0;
      const adapter = makeAdapter({
        hydrate: async (job, _item, _ctx, fetchJson) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await fetchJson({ url: `${DETAIL}/${job.externalId}` }); // suspends so peak is observable
          inFlight -= 1;
          return { descriptionText: "h" };
        },
      });

      const jobs = await runAdapter(adapter, "acme", { hydrateConcurrency: 2 });

      expect(jobs).toHaveLength(5);
      expect(peak).toBe(2); // never more than 2 hydrate calls in flight at once
    });

    it("hydrate's injected fetchJson is the resilient path — a transient detail 503 is retried", async () => {
      server.use(http.get(LIST, () => HttpResponse.json({ jobs: [raw(1)] })));
      let detailCalls = 0;
      server.use(
        http.get(`${DETAIL}/:id`, () => {
          detailCalls += 1;
          if (detailCalls === 1) {
            return new HttpResponse(null, { status: 503, headers: { "retry-after": "0" } });
          }
          return HttpResponse.json({ title: "hydrated title" });
        }),
      );
      const adapter = makeAdapter({
        hydrate: async (job, _item, _ctx, fetchJson) => {
          const detail = (await fetchJson({ url: `${DETAIL}/${job.externalId}` })) as {
            title: string;
          };
          return { title: detail.title };
        },
      });

      const jobs = await runAdapter(adapter, "acme");

      expect(detailCalls).toBe(2); // the resilient fetchJson retried the 503
      expect(jobs[0]?.title).toBe("hydrated title");
    });
  });
});
