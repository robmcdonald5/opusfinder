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
  upsertCompany,
  upsertJobs,
} from "@opusfinder/db/repos";
import type { SourceName } from "@opusfinder/shared";
import { sleep } from "@opusfinder/shared/async";

import { fetchJobs } from "./adapters";
import type { RunAdapterOptions } from "./adapters/run-adapter";

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
  embedded: number;
  embedTokens: number;
  error?: string;
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
  /** ms between boards so we don't hammer shared ATS infra (Workable 429s on rapid calls). */
  paceMs?: number;
  /** Forwarded to `fetchJobs`/`runAdapter` — a Worker may LOWER `hydrateConcurrency` for subrequests. */
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
   * Optional per-board progress hook, fired once per board as it finishes (success or failure).
   * The library stays quiet by default (only the run summary is logged); the CLI supplies this to
   * restore real-time per-board output, the Worker omits it. MUST NOT throw — a throwing hook is
   * the caller's bug, not a board failure.
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
  failed: number; // boards that threw (isolated — does NOT fail the run)
  jobs: number; // distinct postings persisted
  changed: number; // inserted-or-updated postings
  embedded: number; // postings embedded inline (0 when `embed` omitted)
  embedTokens: number; // Voyage tokens used
  embedFailed: number; // boards whose embed step threw (jobs still persisted)
  // Per-board lifecycle sweep (gated total>0). Count-only/shadow mode keeps `closed` at 0 and
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

/**
 * Run one ingestion pass. Per-board failures are ISOLATED — a dead slug / 5xx increments
 * `failed`, captures the first board error into `errorSample`, and the loop continues, so a
 * single bad board never halts the run. Only an infrastructural fault (e.g. `listCompanies`
 * itself throwing) terminalizes the run `status: "error"`. Ingestion failures land in
 * `source_runs` only, never in `markProbeResult` — a transient ATS 5xx must not deactivate a board.
 */
export async function runIngestion(db: Db, opts: IngestionOptions = {}): Promise<IngestionCounts> {
  const paceMs = opts.paceMs ?? DEFAULT_PACE_MS;
  const counts = emptyCounts();
  const startMs = Date.now();
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

    for (const [i, company] of list.entries()) {
      // Wall-clock budget (Worker-only — see opts.maxRunMs): stop STARTING new boards once the budget is
      // spent, so `finishRun` is always reached within the Worker's 15-min limit. `i > 0` guarantees at
      // least one board runs (its own cost is bounded by adapter.maxItems); BREAK (not return) so the
      // finishRun + summary below still run and the handler advances the cursor to the last processed id.
      if (i > 0 && opts.maxRunMs !== undefined && Date.now() - startMs >= opts.maxRunMs) break;
      if (i > 0) await sleep(paceMs);
      counts.lastId = company.id; // advance the chunk cursor even when this board fails
      try {
        const normalized = await fetchJobs(company.source, company.slug, opts.adapter);
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
        // Idempotent get-or-create from the canonical slug (not jobs[0]) keeps a valid-but-
        // empty board recorded too.
        const companyId = await upsertCompany(db, company.slug, company.source);
        const { changed, total } = await upsertJobs(db, companyId, normalized);
        counts.jobs += total;
        counts.changed += changed;
        counts.ok += 1;

        // Liveness stamp (EVERY board, capped or not — see markJobsPresent): refresh last_seen_at for
        // the jobs this fetch returned + revive any reappearing closed ones, then certify a successful
        // non-empty fetch (markCompanyIngested) so the staleness timer's board-health guard knows this
        // board is fetchable. GATED on total > 0: an empty/ambiguous fetch (e.g. SmartRecruiters
        // 200+totalFound:0 → []) must NOT stamp presence OR certify health. `presentExternalIds` is the
        // board's de-duplicated external_ids (== what upsertJobs persisted; length === total). Isolated
        // like the sweep/embed steps: a stamp fault leaves jobs persisted and self-heals next cycle.
        // ORDER IS LOAD-BEARING — markJobsPresent (stamp last_seen) BEFORE markCompanyIngested (certify
        // board health): if the company were certified first and the job-stamp then threw, the timer could
        // close jobs that were never re-stamped. This order fails SAFE (jobs stamped, board left
        // uncertified ⇒ guard spares it).
        let presentExternalIds: string[] | undefined;
        if (total > 0) {
          presentExternalIds = [...new Set(normalized.map((j) => j.externalId))];
          try {
            const present = await markJobsPresent(db, companyId, presentExternalIds);
            counts.revived += present.revived; // closed→active revivals (works for capped boards too)
            await markCompanyIngested(db, companyId);
          } catch (err) {
            counts.markFailed += 1;
            // Shape-only (no job text); companyId is a non-secret int.
            console.warn(
              `markJobsPresent/markCompanyIngested failed for company ${companyId}: ` +
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
        if (presentExternalIds !== undefined && !capped) {
          try {
            const sweep = await sweepLifecycle(db, companyId, presentExternalIds, {
              enforce: opts.enforceLifecycle ?? false,
            });
            counts.revived += sweep.revived;
            counts.swept += sweep.swept;
            counts.closed += sweep.closed;
            counts.wouldClose += sweep.wouldClose;
          } catch (err) {
            counts.sweepFailed += 1;
            // Shape-only (no job text): the count feeds item-6 health; companyId is a non-secret int.
            console.warn(
              `sweepLifecycle failed for company ${companyId}: ` +
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
              companyId,
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
          embedded: boardEmbedded,
          embedTokens: boardTokens,
          error: embedWarning,
        });
      } catch (err) {
        counts.failed += 1; // ISOLATE: one dead slug / 5xx never halts the run
        const message = err instanceof Error ? err.message : String(err);
        errorSample ??= sampleOf(company, message); // FIRST board error only, truncated + secret-free
        opts.onBoard?.({
          source: company.source,
          slug: company.slug,
          ok: false,
          jobs: 0,
          changed: 0,
          embedded: 0,
          embedTokens: 0,
          error: message,
        });
      }
      counts.processed += 1; // boards we got through (ok or failed) — the early-stop cursor signal
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
    jobs: 0,
    changed: 0,
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
      (counts.staleWouldClose > 0 || counts.staleClosed > 0 || counts.staleSweepFailed > 0
        ? `; stale: ${counts.staleWouldClose} would-close, ${counts.staleClosed} closed` +
          (counts.staleSweepFailed > 0 ? `, ${counts.staleSweepFailed} stale-sweep-failed` : "")
        : "") +
      ".",
  );
}
