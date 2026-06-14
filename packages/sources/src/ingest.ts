/**
 * Multi-source ingestion as a LIBRARY: iterate the companies rows, fetch + normalize each
 * board through its adapter, upsert it, and (optionally) embed the new/changed postings — all
 * under one `source_runs` row. Extracted (Phase 8) from the `ingest-all.ts` script so the
 * Phase-8 Worker cron and the CLI share ONE code path. Mirrors `runDiscovery`'s shape exactly:
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
  startRun,
  sweepLifecycle,
  upsertCompany,
  upsertJobs,
} from "@opusfinder/db/repos";
import type { SourceName } from "@opusfinder/shared";
import { sleep } from "@opusfinder/shared/async";

import { fetchJobs } from "./adapters";
import type { RunAdapterOptions } from "./adapters/run-adapter";

/**
 * The injected embedder — the structural MINIMUM that `backfillJobEmbeddings` accepts (its
 * private `EmbedFn`). The real `embed()` from `@opusfinder/embeddings` returns a superset (it
 * also carries `model`), so passing it directly — or, in the Worker, the apiKey-bound closure
 * `(t, p) => embed(t, { ...p, apiKey })` — satisfies this via structural subtyping. Omit
 * `embed` to skip inline embedding entirely (the default on the Voyage free tier, whose 3 RPM
 * cap a frequent tick would exhaust): jobs are still upserted; the idempotent backfill fills
 * the still-NULL vectors later.
 */
export type IngestEmbedFn = (
  texts: string[],
  params: { inputType: "query" | "document" | null },
) => Promise<{ embeddings: number[][]; usage: { totalTokens: number } }>;

/**
 * One board's outcome, handed to the optional `onBoard` progress hook as each board finishes.
 * The library itself only logs the run-level summary; a caller that wants real-time per-board
 * visibility (the CLI) supplies `onBoard`, while a quiet caller (the Worker) omits it. `error`
 * is the board-failure message when `ok` is false, OR an embed-failure warning on an otherwise-
 * ok board (jobs were still persisted).
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
   * Skip boards discovery has deactivated (Phase-7 deferred #5). Defaults to TRUE — the Worker
   * cron, and any direct caller that omits this, wants only live boards. The CLI passes `false`
   * to preserve its prior "ingest every row" behavior (a manual run may want to re-check a
   * deactivated board).
   */
  activeOnly?: boolean;
  /**
   * Chunk cursor: process only boards with `id > afterId` (the Option-A chunked-cron lane).
   * Pushed into the `listCompanies` SQL as an id-keyset `WHERE id > afterId` (not an in-memory
   * filter). Omit = from the start. The handler persists `counts.lastId` as the next tick's
   * `afterId`.
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
   * Optional per-board progress hook, fired once per board as it finishes (success or failure).
   * The library stays quiet by default (only the run summary is logged); the CLI supplies this to
   * restore real-time per-board output, the Worker omits it. MUST NOT throw — a throwing hook is
   * the caller's bug, not a board failure.
   */
  onBoard?: (result: IngestBoardResult) => void;
}

/**
 * Flat metric bag, persisted verbatim to `source_runs.counts` (the index signature keeps it
 * assignable to the db `RunCounts` = `Record<string, number>` while the named fields give typed
 * access). `companies` is the number of boards PROCESSED THIS RUN — the `afterId`/`limit` chunk
 * after the `activeOnly` filter — NOT the total active board count; the chunk-cursor wrap test
 * (`companies < limit` ⇒ sweep done ⇒ reset) depends on that meaning.
 */
export interface IngestionCounts {
  [key: string]: number;
  companies: number; // boards processed THIS run (the activeOnly + afterId + limit chunk)
  ok: number; // boards fetched + upserted cleanly
  failed: number; // boards that threw (isolated — does NOT fail the run)
  jobs: number; // distinct postings persisted
  changed: number; // inserted-or-updated postings
  embedded: number; // postings embedded inline (0 when `embed` omitted)
  embedTokens: number; // Voyage tokens used
  embedFailed: number; // boards whose embed step threw (jobs still persisted)
  // F2 Arm A lifecycle sweep (per board, gated total>0). Count-only/shadow mode keeps `closed` at 0 and
  // reports `wouldClose` as the standing "would close if enforced" population; F2-enforce flips the write on.
  revived: number; // reappeared postings: active-streak resets + closed→active revivals
  swept: number; // absent postings whose streak incremented but is still below the close threshold
  closed: number; // postings flipped to 'closed' (enforce only; always 0 in shadow)
  wouldClose: number; // absent postings at/over threshold NOT yet closed (shadow standing population)
  sweepFailed: number; // boards whose sweep step threw (jobs still persisted; self-heals next cycle)
  lastId: number; // max company id seen — the next tick's `afterId` cursor (0 if none)
}

const DEFAULT_PACE_MS = 500;

/**
 * Run one ingestion pass. Per-board failures are ISOLATED — a dead slug / 5xx increments
 * `failed`, captures the first board error into `errorSample`, and the loop continues, so a
 * single bad board never halts the run (done-when 3). Only an infrastructural fault (e.g.
 * `listCompanies` itself throwing) terminalizes the run `status: "error"`. Phase-7 decision 7.6
 * stands: ingestion failures land in `source_runs` only, never in `markProbeResult` — a
 * transient ATS 5xx must not deactivate a board.
 */
export async function runIngestion(db: Db, opts: IngestionOptions = {}): Promise<IngestionCounts> {
  const paceMs = opts.paceMs ?? DEFAULT_PACE_MS;
  const counts = emptyCounts();
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
      if (i > 0) await sleep(paceMs);
      counts.lastId = company.id; // advance the chunk cursor even when this board fails
      try {
        const normalized = await fetchJobs(company.source, company.slug, opts.adapter);
        // Idempotent get-or-create from the canonical slug (not jobs[0]) keeps a valid-but-
        // empty board recorded too.
        const companyId = await upsertCompany(db, company.slug, company.source);
        const { changed, total } = await upsertJobs(db, companyId, normalized);
        counts.jobs += total;
        counts.changed += changed;
        counts.ok += 1;

        // F2 Arm A: soft-close postings absent from THIS board's fetch (streak hysteresis; revive on
        // reappearance), in count-only/shadow mode (F2-SHADOW — tally `wouldClose`, write no 'closed' yet;
        // F2-enforce flips it on). GATED on total > 0 (decision 4): an empty/ambiguous fetch (e.g.
        // SmartRecruiters 200+totalFound:0 → []) must NEVER sweep — `<> ALL('{}')` would false-close the
        // whole board. PER-COMPANY inside this per-board try — NEVER hoist to a run-level seen-set: the cron
        // processes only an id-keyset chunk per tick, so a run-level sweep would close every company NOT in
        // the chunk. `presentExternalIds` is the board's de-duplicated external_ids (== what upsertJobs just
        // persisted; length === total). Isolated like the embed step: a sweep fault leaves jobs persisted and
        // self-heals next cycle, so it must not fail the board.
        if (total > 0) {
          try {
            const presentExternalIds = [...new Set(normalized.map((j) => j.externalId))];
            // F2-ENFORCE FLIP SITE 1 of 3 (also discover.ts Arm B + digest.ts Arm C): pass { enforce: true }
            // here AND at the other two together. There is no shared switch, so a partial flip silently
            // leaves an arm in shadow with no compile/test signal — flip all three or none.
            const sweep = await sweepLifecycle(db, companyId, presentExternalIds);
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
      ".",
  );
}
