/**
 * Multi-source ingestion as a LIBRARY: iterate the companies rows, fetch + normalize each
 * board through its adapter, upsert it, and (optionally) embed the new/changed postings — all
 * under one `source_runs` row. A shared code path for both the Worker cron and the CLI:
 * argv-free, `db` injected, owns its run row, returns a flat counts bag, logs one summary line.
 *
 * Worker-forward: the only environment touchpoints — argv, `process.env`, the embedder's Voyage
 * key — are INJECTED by the caller, never read here. The embedder is injected (not imported) so
 * this module carries zero dependency on `@opusfinder/embeddings` and its key-reading env module.
 */
import type { Db } from "@opusfinder/db";
import {
  backfillJobEmbeddings,
  finishRun,
  listCompanies,
  markCompanyIngested,
  markJobsPresent,
  startRun,
  sweepLifecycle,
  sweepStaleJobs,
  upsertJobs,
} from "@opusfinder/db/repos";
import type { SourceName } from "@opusfinder/shared";
import { sleep } from "@opusfinder/shared/async";

import { adapterFor, paceMsOf, pacingKeyOf } from "./adapters";
import {
  RATE_LIMIT_MIN_COOLDOWN_MS,
  RateLimitedError,
  fetchBoard,
  type RunAdapterOptions,
} from "./adapters/run-adapter";

/**
 * The injected embedder — the structural MINIMUM that `backfillJobEmbeddings` accepts. The real
 * `embed()` returns a superset, so it satisfies this via structural subtyping. Omit `embed` to
 * skip inline embedding (the default on the Voyage free tier, whose 3 RPM a frequent tick would
 * exhaust): jobs are still upserted; the idempotent backfill fills the still-NULL vectors later.
 */
export type IngestEmbedFn = (
  texts: string[],
  params: { inputType: "query" | "document" | null },
) => Promise<{ embeddings: number[][]; usage: { totalTokens: number } }>;

/**
 * One board's outcome, handed to the optional `onBoard` progress hook as each board finishes.
 * `error` is the board-failure message when `ok` is false, OR an embed-failure warning on an
 * otherwise-ok board (jobs were still persisted).
 */
export interface IngestBoardResult {
  source: SourceName;
  slug: string;
  ok: boolean;
  jobs: number;
  changed: number;
  /** Listed postings whose detail fetch failed (content not written — only a stored row's company_id
   *  follows the board; still present) — so a board whose every hydrate failed reads as such, not as an
   *  empty board. */
  hydrateSkipped: number;
  embedded: number;
  embedTokens: number;
  error?: string;
  /** Set when the board was NOT fetched: its pacing key was still cooling down from a rate limit at the
   *  end of the run (`ok` false, no `error` — not a failure). */
  skipped?: "rate-limited";
}

export interface IngestionOptions {
  /** Scope to one source (omit = all). Forwarded to `listCompanies` + the run row. */
  source?: SourceName;
  /**
   * Skip boards discovery has deactivated. Defaults to TRUE — the Worker cron, and any direct
   * caller that omits this, wants only live boards. The CLI passes `false` to preserve its prior
   * "ingest every row" behavior (a manual run may want to re-check a deactivated board).
   */
  activeOnly?: boolean;
  /**
   * Chunk cursor: process only boards with `id > afterId`. Pushed into the `listCompanies` SQL
   * as an id-keyset `WHERE id > afterId` (not an in-memory filter). Omit = from the start. The
   * handler persists `counts.lastId` as the next tick's `afterId`.
   */
  afterId?: number;
  /**
   * Cap boards processed THIS run (the cron's wall / subrequest budget). Pushed into the
   * `listCompanies` SQL `LIMIT` so only the chunk is fetched, never the whole table. Omit = all.
   */
  limit?: number;
  /** Inline embedder (injected). Omit ⇒ no inline embedding. */
  embed?: IngestEmbedFn;
  /**
   * Minimum ms between a board FINISHING and the next board with the same pacing key (the adapter's
   * `pacingKey`, default its source) starting, so we don't hammer one ATS's infra (Workable 429s on rapid
   * calls) — the old "≥ paceMs after the previous board", kept per key. Paced by TIME, not adjacency:
   * before a board, sleep only what's left of `paceMs` since its key's last board finished — so
   * alternating sources can't burst one host, and a board after enough other work waits for nothing.
   * A FLOOR: a key whose adapters declare a slower `paceMs` (Workable's 1000) uses that instead.
   */
  paceMs?: number;
  /** Clock (epoch ms) for the `maxRunMs` budget and the per-key pacing. Defaults to `Date.now`; a test
   *  injects one to drive both deterministically. */
  clock?: () => number;
  /** Forwarded to `fetchJobs`/`runAdapter` — a Worker may LOWER `hydrateConcurrency` for subrequests, and
   *  passes `maxRetryWaitMs` to fail fast on rate limits (see the cooldown in the board loop). */
  adapter?: RunAdapterOptions;
  /**
   * Wall-clock budget (ms) for the whole run (Worker-only). Once exceeded, the board loop STOPS
   * starting new boards, then finishes the run cleanly — guaranteeing `finishRun` is reached and the
   * cursor advances, so a heavy chunk can never kill the tick mid-run and re-pin the cursor on the
   * same poison chunk. The in-flight board always completes (bounded by `adapter.maxItems`). Omit ⇒
   * no budget (the CLI, in Node, has no per-invocation limit). See `counts.processed`.
   */
  maxRunMs?: number;
  /**
   * Optional per-board progress hook, fired once per board as it finishes (success or failure). A board a
   * rate-limit cooldown skipped is reported once, after the second pass: its outcome if retried there, else
   * `skipped: "rate-limited"`. A board whose own fetch was 429'd is reported failed, then again with its
   * retry's outcome if the second pass retries it. The library stays quiet by default (only the run summary is logged); the CLI
   * supplies this to restore real-time per-board output, the Worker omits it. MUST NOT throw — a throwing
   * hook is the caller's bug, not a board failure.
   */
  onBoard?: (result: IngestBoardResult) => void;
  /**
   * Lifecycle-close enforcement. Default false = SHADOW (the sweep increments the absence streak +
   * revives, but writes no `'closed'`, tallying `wouldClose`). The Worker passes
   * `parseEnforceFlag(env.LIFECYCLE_CLOSE_ENFORCE)`; flip enforce on once the shadow counters are reviewed.
   */
  enforceLifecycle?: boolean;
  /**
   * Universal staleness sweep (opt-in, Worker-driven). When set, AFTER the per-board loop the run
   * closes any active job not re-confirmed (last_seen_at, stamped by markJobsPresent) within `ttlDays`
   * — GATED by the board-health guard, so only jobs of boards SUCCESSFULLY ingested within the same
   * window close (a board down for >TTL has its live jobs spared). This is the completeness-INDEPENDENT
   * backstop that closes a healthy capped mega-board's aged-out tail (see {@link sweepStaleJobs}). Omit
   * ⇒ no stale sweep (the CLI default). `enforce` rides its OWN switch (STALE_SWEEP), INDEPENDENT of
   * `enforceLifecycle`/LIFECYCLE_CLOSE_ENFORCE, so it ships shadow-first; `ttlDays` defaults to
   * {@link DEFAULT_STALE_TTL_DAYS} when omitted.
   */
  staleSweep?: { ttlDays?: number; enforce: boolean };
}

/**
 * Flat metric bag, persisted verbatim to `source_runs.counts` (the index signature keeps it
 * assignable to `RunCounts` = `Record<string, number>` while the named fields give typed access).
 * `companies` is the size of the `afterId`/`limit` SQL chunk (after `activeOnly`) — NOT the total
 * active board count; the chunk-cursor wrap test (`companies < limit` ⇒ end of table ⇒ reset)
 * depends on that. `processed` is how many of those boards actually ran: it equals `companies`
 * unless the `maxRunMs` budget stopped the loop early, which the handler uses to advance (not wrap)
 * the cursor mid-chunk.
 */
export interface IngestionCounts {
  [key: string]: number;
  companies: number; // size of the activeOnly + afterId + limit SQL chunk (NOT necessarily all processed)
  processed: number; // boards actually processed (< companies ⇒ the maxRunMs budget stopped the loop early)
  ok: number; // boards fetched + upserted cleanly
  failed: number; // boards that threw (isolated — does NOT fail the run); a second-pass retry replaces its 429
  rateLimitSkipped: number; // boards left unfetched: their pacing key was cooling down from a rate limit (NOT in failed)
  jobs: number; // distinct postings persisted
  changed: number; // inserted-or-updated postings
  hydrateSkipped: number; // listed postings whose detail fetch failed: content kept (only company_id refreshed) / new one deferred; still present
  hydrateListed: number; // postings listed by HYDRATING boards (written + hydrateSkipped) — the health ratio's denominator
  embedded: number; // postings embedded inline (0 when `embed` omitted)
  embedTokens: number; // Voyage tokens used
  embedFailed: number; // boards whose embed step threw (jobs still persisted)
  // Per-board lifecycle sweep (gated on a non-empty fetch). Count-only/shadow mode keeps `closed` at 0 and
  // reports `wouldClose` as the standing "would close if enforced" population; enforce flips the write on.
  revived: number; // reappeared postings: active-streak resets + closed→active revivals
  swept: number; // absent postings whose streak incremented but is still below the close threshold
  closed: number; // postings flipped to 'closed' (enforce only; always 0 in shadow)
  wouldClose: number; // absent postings at/over threshold NOT yet closed (shadow standing population)
  sweepFailed: number; // boards whose sweep step threw (jobs still persisted; self-heals next cycle)
  // Observability + universal staleness sweep (run-level, post-loop).
  markFailed: number; // boards whose markJobsPresent/markCompanyIngested liveness stamp threw (jobs still persisted)
  cappedBoards: number; // boards whose fetch hit adapter.maxItems (partial → Arm A sweep skipped → covered by the stale timer)
  staleClosed: number; // jobs closed by the staleness timer this run (STALE_SWEEP enforce only; always 0 in shadow)
  staleWouldClose: number; // active jobs past the TTL the timer WOULD close (shadow standing population; 0 in enforce)
  staleSweepFailed: number; // 1 if the post-loop stale sweep threw (jobs untouched; self-heals next tick), else 0
  lastId: number; // max company id seen — the next tick's `afterId` cursor (0 if none)
}

const DEFAULT_PACE_MS = 500;
// A rate-limited pacing key's cooldown: the host's Retry-After, at least RATE_LIMIT_MIN_COOLDOWN_MS and at
// most 10 min (the Worker's whole budget).
// Known limitations: a short blip is retried in the same tick (the second pass), but under PERSISTENT
// throttling a skipped board waits a full sweep (~20 h) for its next try, and meanwhile the stale sweep
// spares its uncertified jobs (`rateLimitSkipped` shows it). A host's burst quota can leave the tail of a
// huge board unhydrated (in `hydrateSkipped`; content kept). Discovery's prober
// (packages/discovery/src/probe.ts) still hits apply.workable.com at up to ~2.5 req/s (follow-up).
const RATE_LIMIT_COOLDOWN_MAX_MS = 10 * 60_000;

/**
 * Run one ingestion pass. Per-board failures are ISOLATED — a dead slug / 5xx increments
 * `failed`, captures the first board error into `errorSample`, and the loop continues, so a
 * single bad board never halts the run. Only an infrastructural fault (e.g. `listCompanies`
 * itself throwing) terminalizes the run `status: "error"`. Ingestion failures land in
 * `source_runs` only, never in `markProbeResult` — a transient ATS 5xx must not deactivate a board.
 */
export async function runIngestion(db: Db, opts: IngestionOptions = {}): Promise<IngestionCounts> {
  const paceMs = opts.paceMs ?? DEFAULT_PACE_MS;
  const clock = opts.clock ?? Date.now;
  const counts = emptyCounts();
  const startMs = clock();
  // Pacing key → when its most recent board FINISHED (see opts.paceMs), and, after a rate limit, the time
  // before which its boards are skipped (see RATE_LIMIT_COOLDOWN_MAX_MS).
  const keys = new Map<string, { lastFinish?: number; notBefore?: number }>();
  const runId = await startRun(db, "ingestion", { source: opts.source });
  let errorSample: string | undefined;

  try {
    // The chunk is built in SQL (id-keyset WHERE id > afterId ORDER BY id LIMIT limit) — only the
    // chunk's rows are fetched, never the whole table.
    const list = await listCompanies(db, {
      source: opts.source,
      activeOnly: opts.activeOnly ?? true,
      afterId: opts.afterId,
      limit: opts.limit,
    });
    counts.companies = list.length;

    // Boards a rate limit cost in the main loop (skipped, or 429'd themselves) — retried by the second pass.
    const deferred: { company: (typeof list)[number]; outcome: "skipped" | "rate-limited" }[] = [];

    // One board — fetch, upsert, stamp, sweep, embed — with its failures ISOLATED. "skipped": nothing done,
    // its pacing key is cooling down from a rate limit; "rate-limited": it failed on a 429.
    const runBoard = async (
      company: (typeof list)[number],
    ): Promise<"done" | "skipped" | "rate-limited"> => {
      // Recorded after the board (see the end of the loop body); the raw source until the adapter resolves.
      let pacingKey: string = company.source;
      let rateLimit: RateLimitedError | undefined; // the host rate-limited this board's list or a detail fetch
      let outcome: "done" | "rate-limited" = "done";
      try {
        // The adapter is looked up ONCE, INSIDE the try: a row whose source has no adapter (a poison row)
        // throws `unknown source "<x>"` here and fails only its own board. Reused for pacing, the fetch and
        // the hydrate check below.
        const adapter = adapterFor(company.source);
        pacingKey = pacingKeyOf(adapter);
        const key = keys.get(pacingKey);
        // Cooling down from a rate limit: SKIP — no request, no pause, no presence stamp, sweep or
        // certification. Not a failure: the caller counts it in rateLimitSkipped.
        if (key?.notBefore !== undefined && clock() < key.notBefore) return "skipped";
        // Politeness is per ATS HOST, i.e. per PACING KEY (the adapter's `pacingKey`, default its source —
        // types.ts lists the host audit). Paced by TIME, not adjacency: start a board only ≥ the key's pace
        // (paceMs, or slower if the key's adapters declare it) after its previous board FINISHED, sleeping just
        // the remainder. Adjacency alone let alternating sources (gh, lever, gh, lever…) hit one host
        // back-to-back; time also skips the pause when other boards ran in between for long enough.
        if (key?.lastFinish !== undefined) {
          const wait = Math.max(paceMs, paceMsOf(pacingKey)) - (clock() - key.lastFinish);
          if (wait > 0) await sleep(wait);
        }
        const board = await fetchBoard(adapter, company.slug, opts.adapter);
        const normalized = board.jobs;
        rateLimit = board.rateLimited; // a detail fetch's: the board still succeeds, but its key cools down below
        // A capped board (adapter.maxItems truncated the fetch) is PARTIAL — its present-set is
        // incomplete, so the F2 feed-absence sweep below MUST be skipped or it would false-close the
        // un-fetched tail. runAdapter trims to EXACTLY maxItems, so length >= cap ⇔ capped.
        const cap = opts.adapter?.maxItems;
        const capped = cap !== undefined && normalized.length >= cap;
        // A capped board is a PARTIAL fetch that skips the feed-absence sweep below (it would
        // false-close the un-fetched tail). Count it so the sweep-exempt population is visible in
        // source_runs.counts. These boards aren't exempt overall: the post-loop staleness timer
        // (sweepStaleJobs) is their close path.
        if (capped) counts.cappedBoards += 1;
        // The company id comes straight from listCompanies (`company.id`) — no per-board upsertCompany,
        // which was a no-op `ON CONFLICT DO UPDATE SET slug = excluded.slug` returning that same id (a
        // wasted neon-http round-trip plus a dead tuple per board per tick).
        // upsertJobs never writes a failed hydrate's content (see its guard): a `contentMissing` posting's
        // stored row keeps its content (only its company_id follows this board) and a new one waits for a
        // later run. Its counts are DISTINCT postings, tallied only once the write succeeded (a throw fails
        // the board, counting none).
        const upserted = await upsertJobs(db, company.id, normalized);
        const { changed, total } = upserted;
        counts.jobs += total;
        counts.changed += changed;
        counts.hydrateSkipped += upserted.contentMissing;
        // The hydrate_skip_ratio health check's denominator: only boards whose adapter hydrates, so the
        // many non-hydrating postings can't dilute a failing detail endpoint.
        if (adapter.hydrate) counts.hydrateListed += total + upserted.contentMissing;
        counts.ok += 1;

        // Liveness stamp (EVERY board, capped or not — see markJobsPresent): refresh last_seen_at for
        // the jobs this fetch returned + revive any reappearing closed ones, then certify a successful
        // non-empty fetch (markCompanyIngested) so the staleness timer's board-health guard knows this
        // board is fetchable. GATED on `listed` (the board listed ≥1 posting): an empty/ambiguous fetch
        // (e.g. SmartRecruiters 200+totalFound:0 → []) must NOT stamp presence OR certify health. The gate
        // is the LISTING, not `total` — a board whose every hydrate failed writes nothing but is live.
        // `listedIds` is every de-duplicated external_id the board listed — what upsertJobs persisted PLUS the
        // contentMissing postings it did not write: a posting whose detail fetch failed is still listed, so it
        // must neither age toward the staleness timer nor count as absent in the sweep below. (Known
        // limitation, an accepted trade-off: a stored posting whose detail is 404/410/"not available" while
        // still listed stays active and digest-eligible — retrieved and reranked — until the ATS delists it;
        // and hydrate_skip_ratio can't tell those not-founds from 5xx, so steady list lag can hold the ratio
        // up. Known follow-up: a separate not-found counter. See smartrecruiters.ts hydratePosting.)
        // Isolated like the sweep/embed steps: a stamp fault leaves jobs persisted and self-heals next cycle.
        // ORDER IS LOAD-BEARING — markJobsPresent (stamp last_seen) BEFORE markCompanyIngested (certify
        // board health): if the company were certified first and the job-stamp then threw, the timer could
        // close jobs that were never re-stamped. This order fails SAFE (jobs stamped, board left
        // uncertified ⇒ guard spares it).
        const listedIds = [...new Set(normalized.map((j) => j.externalId))];
        const listed = listedIds.length > 0;
        if (listed) {
          try {
            const present = await markJobsPresent(db, company.id, listedIds);
            counts.revived += present.revived; // closed→active revivals (works for capped boards too)
            await markCompanyIngested(db, company.id);
          } catch (err) {
            counts.markFailed += 1;
            // Shape-only (no job text); company.id is a non-secret int.
            console.warn(
              `markJobsPresent/markCompanyIngested failed for company ${company.id}: ` +
                `${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
            );
          }
        }

        // Soft-close postings absent from THIS board's COMPLETE fetch (streak hysteresis), in
        // count-only/shadow or enforce per opts.enforceLifecycle. SKIPPED on a capped/partial fetch — a
        // partial present-set would false-close the un-fetched tail (`<> ALL` over an incomplete set);
        // those boards rely on the staleness timer (sweepStaleJobs) instead. Enforcement rides
        // parseEnforceFlag(LIFECYCLE_CLOSE_ENFORCE). Isolated like the stamp/embed steps. Closed→active revivals are
        // owned by markJobsPresent above; sweepLifecycle.revived here counts only still-active streak resets.
        if (listed && !capped) {
          try {
            const sweep = await sweepLifecycle(db, company.id, listedIds, {
              enforce: opts.enforceLifecycle ?? false,
            });
            counts.revived += sweep.revived;
            counts.swept += sweep.swept;
            counts.closed += sweep.closed;
            counts.wouldClose += sweep.wouldClose;
          } catch (err) {
            counts.sweepFailed += 1;
            // Shape-only (no job text): the count feeds item-6 health; company.id is a non-secret int.
            console.warn(
              `sweepLifecycle failed for company ${company.id}: ` +
                `${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
            );
          }
        }

        let boardEmbedded = 0;
        let boardTokens = 0;
        let embedWarning: string | undefined;
        if (opts.embed && total > 0) {
          try {
            const { embedded, tokens } = await backfillJobEmbeddings(db, opts.embed, {
              companyId: company.id,
              inputType: "document",
            });
            boardEmbedded = embedded;
            boardTokens = tokens;
            counts.embedded += embedded;
            counts.embedTokens += tokens;
          } catch (err) {
            // Jobs are already persisted; a Voyage hiccup just leaves NULL vectors for the next
            // idempotent backfill. It must not fail the board or the run, nor mask a board error
            // in `errorSample` — the count + the per-board warning surface it.
            counts.embedFailed += 1;
            embedWarning = err instanceof Error ? err.message : String(err);
          }
        }
        opts.onBoard?.({
          source: company.source,
          slug: company.slug,
          ok: true,
          jobs: total,
          changed,
          hydrateSkipped: upserted.contentMissing,
          embedded: boardEmbedded,
          embedTokens: boardTokens,
          error: embedWarning,
        });
      } catch (err) {
        counts.failed += 1; // ISOLATE: one dead slug / 5xx never halts the run
        if (err instanceof RateLimitedError) {
          rateLimit = err;
          outcome = "rate-limited";
        }
        const message = err instanceof Error ? err.message : String(err);
        errorSample ??= sampleOf(company, message); // FIRST board error only, truncated + secret-free
        opts.onBoard?.({
          source: company.source,
          slug: company.slug,
          ok: false,
          jobs: 0,
          changed: 0,
          hydrateSkipped: 0,
          embedded: 0,
          embedTokens: 0,
          error: message,
        });
      }
      const finishedAt = clock(); // ok or failed — either way this key's host was just hit
      const keyState = keys.get(pacingKey) ?? {};
      keyState.lastFinish = finishedAt;
      if (rateLimit) {
        const cooldown = Math.max(rateLimit.retryAfterMs, RATE_LIMIT_MIN_COOLDOWN_MS);
        keyState.notBefore = finishedAt + Math.min(cooldown, RATE_LIMIT_COOLDOWN_MAX_MS);
      }
      keys.set(pacingKey, keyState);
      return outcome;
    };

    for (const [i, company] of list.entries()) {
      // Wall-clock budget (Worker-only — see opts.maxRunMs): stop STARTING new boards once the budget is
      // spent, so `finishRun` is always reached within the Worker's 15-min limit. `i > 0` guarantees at
      // least one board runs (its own cost is bounded by adapter.maxItems); BREAK (not return) so the
      // finishRun + summary below still run and the handler advances the cursor to the last processed id.
      if (i > 0 && opts.maxRunMs !== undefined && clock() - startMs >= opts.maxRunMs) break;
      counts.lastId = company.id; // advance the chunk cursor even when this board fails or is skipped
      const outcome = await runBoard(company);
      if (outcome === "skipped") counts.rateLimitSkipped += 1;
      if (outcome !== "done") deferred.push({ company, outcome });
      counts.processed += 1; // boards we got through (ok, failed or skipped) — the early-stop cursor signal
    }

    // Second pass: retry — WITHOUT waiting — the boards a rate limit cost whose key has cooled off since, while
    // the budget lasts, so a short blip costs no coverage. Each board is counted once: the retry's ok/failed
    // replaces its skip or its 429 failure; it is already in processed and the cursor stays where the loop
    // left it. A board still cooling keeps its first outcome (a skip is reported here).
    for (const { company, outcome } of deferred) {
      const budgetLeft = opts.maxRunMs === undefined || clock() - startMs < opts.maxRunMs;
      if (budgetLeft && (await runBoard(company)) !== "skipped") {
        if (outcome === "skipped") counts.rateLimitSkipped -= 1;
        else counts.failed -= 1;
        continue;
      }
      if (outcome === "skipped") opts.onBoard?.({
        source: company.source,
        slug: company.slug,
        ok: false,
        skipped: "rate-limited",
        jobs: 0,
        changed: 0,
        hydrateSkipped: 0,
        embedded: 0,
        embedTokens: 0,
      });
    }

    // Universal staleness sweep (opt-in — Worker only; the CLI omits staleSweep). AFTER the board loop
    // so THIS tick's fetches have refreshed last_seen_at first. GLOBAL (all companies in one statement),
    // so a permanently-capped mega-board's aged-out tail and any vanished posting close on ONE clock,
    // independent of feed completeness. ISOLATED like the per-board sweep/embed steps: a failure tallies
    // staleSweepFailed and is swallowed (jobs untouched; self-heals next tick) so it never errors the run.
    // Ships shadow-first via its own STALE_SWEEP switch (enforce here is INDEPENDENT of enforceLifecycle).
    if (opts.staleSweep) {
      try {
        const staleResult = await sweepStaleJobs(db, {
          ttlDays: opts.staleSweep.ttlDays,
          enforce: opts.staleSweep.enforce,
        });
        counts.staleClosed += staleResult.closed;
        counts.staleWouldClose += staleResult.wouldClose;
      } catch (err) {
        counts.staleSweepFailed += 1;
        console.warn(
          `sweepStaleJobs failed: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            200,
          ),
        );
      }
    }

    await finishRun(db, runId, { status: "ok", counts, errorSample });
    logSummary(counts, opts.embed !== undefined);
    return counts;
  } catch (err) {
    // Infrastructural failure (not a per-board one) ⇒ the RUN itself errors.
    const sample = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await finishRun(db, runId, { status: "error", counts, errorSample: sample });
    throw err;
  }
}

/** First-error sample: secret-free (slug + adapter message, never creds), truncated to 500. */
function sampleOf(company: { source: SourceName; slug: string }, message: string): string {
  return `${company.source}:${company.slug} ${message}`.slice(0, 500);
}

function emptyCounts(): IngestionCounts {
  return {
    companies: 0,
    processed: 0,
    ok: 0,
    failed: 0,
    rateLimitSkipped: 0,
    jobs: 0,
    changed: 0,
    hydrateSkipped: 0,
    hydrateListed: 0,
    embedded: 0,
    embedTokens: 0,
    embedFailed: 0,
    revived: 0,
    swept: 0,
    closed: 0,
    wouldClose: 0,
    sweepFailed: 0,
    markFailed: 0,
    cappedBoards: 0,
    staleClosed: 0,
    staleWouldClose: 0,
    staleSweepFailed: 0,
    lastId: 0,
  };
}

/** One shape-only summary line (counts, never secrets) — mirrors `runDiscovery`'s logSummary. */
function logSummary(counts: IngestionCounts, embedEnabled: boolean): void {
  console.log(
    `Ingestion: ${counts.companies} board(s) — ${counts.ok} ok` +
      (counts.failed > 0 ? `, ${counts.failed} failed` : "") +
      (counts.rateLimitSkipped > 0 ? `, ${counts.rateLimitSkipped} rate-limit-skipped` : "") +
      // Only the maxRunMs budget ends the loop early, so processed < companies means it stopped the run.
      (counts.processed < counts.companies
        ? `; budget stop: processed ${counts.processed}/${counts.companies}`
        : "") +
      `; ${counts.jobs} job(s), ${counts.changed} changed` +
      (embedEnabled
        ? `; embedded ${counts.embedded} (${counts.embedTokens} tok)` +
          (counts.embedFailed > 0 ? `, ${counts.embedFailed} embed-failed` : "")
        : "") +
      `; lifecycle: ${counts.revived} revived, ${counts.swept} swept, ${counts.wouldClose} would-close, ` +
      `${counts.closed} closed` +
      (counts.sweepFailed > 0 ? `, ${counts.sweepFailed} sweep-failed` : "") +
      (counts.markFailed > 0 ? `, ${counts.markFailed} mark-failed` : "") +
      (counts.cappedBoards > 0 ? `; ${counts.cappedBoards} capped board(s)` : "") +
      (counts.hydrateSkipped > 0
        ? `; ${counts.hydrateSkipped} posting(s) not written (detail fetch failed; stored content kept)`
        : "") +
      (counts.staleWouldClose > 0 || counts.staleClosed > 0 || counts.staleSweepFailed > 0
        ? `; stale: ${counts.staleWouldClose} would-close, ${counts.staleClosed} closed` +
          (counts.staleSweepFailed > 0 ? `, ${counts.staleSweepFailed} stale-sweep-failed` : "")
        : "") +
      ".",
  );
}
