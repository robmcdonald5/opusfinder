/**
 * Embed one slice of the snapshot with one model: each distinct text once, resumable, and never past
 * the approved spend.
 *
 * - **Once.** Jobs carrying identical text (cross-posts) share one vector: the run embeds the slice's
 *   distinct texts, in first-appearance order, then writes a vectors part aligned to each jobs part.
 * - **Resumable.** Distinct texts are embedded in chunks, each saved as one file named after the texts
 *   it holds. A re-run reuses every chunk already on disk and embeds only the rest.
 * - **Spend guard.** Every billed request is appended to work/spend.jsonl before anything else happens
 *   to its vectors, so spend is never under-counted, whatever crashes. Before each request the run
 *   checks that everything spent so far (every model, every earlier run), plus the requests in flight,
 *   plus this one's estimate stays within `maxUsd`; if not, it stops cleanly and says so.
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

import { chunkByLimits, EmbeddingRejectedError } from "@opusfinder/embeddings";

import { modelCostUsd, type SnapshotModel } from "../embedders/snapshot-models";
import {
  encodeVectors,
  sha256Hex,
  snapshotEmbedText,
  vectorsPartPath,
  type SnapshotJob,
  type SnapshotSlice,
} from "./format";
import { listJobsParts, objectSize, readJobsPart, writeObject } from "./store";

/** Distinct texts per saved chunk: the most a crash can lose (8 MB of vectors at 4096 dims). */
const CHUNK_TEXTS = 512;
// A host's shared token quota can stay exhausted for a minute or more, so a request waits it out:
// 2, 4, 8, 16, 32 s, then a minute at a time (about ten minutes in all) before the run gives up.
const MAX_ATTEMPTS = 14;
const MAX_WAIT_S = 60;
const utf8 = new TextEncoder();

/** Where each jobs part's rows point: the index of its distinct text, or -1 for a job with no text. */
export interface EmbedPlan {
  parts: { path: string; textOf: number[] }[];
  /** SHA-256 of each distinct text, in first-appearance order. */
  hashes: string[];
  /** Where each distinct text first appears, to read it back. */
  firstSeen: { part: number; row: number }[];
  jobs: number;
}

/** One pass over the slice's jobs: which distinct text each row carries. */
export function planSlice(objectsDir: string, slice: SnapshotSlice): EmbedPlan {
  const plan: EmbedPlan = { parts: [], hashes: [], firstSeen: [], jobs: 0 };
  const indexOf = new Map<string, number>();
  for (const [part, path] of listJobsParts(objectsDir, slice).entries()) {
    const textOf = readJobsPart(objectsDir, path).map((job, row) => {
      const { text } = snapshotEmbedText(job);
      if (text === "") return -1;
      const hash = sha256Hex(text);
      let index = indexOf.get(hash);
      if (index === undefined) {
        index = plan.hashes.length;
        indexOf.set(hash, index);
        plan.hashes.push(hash);
        plan.firstSeen.push({ part, row });
      }
      return index;
    });
    plan.parts.push({ path, textOf });
    plan.jobs += textOf.length;
  }
  if (plan.parts.length === 0) throw new Error(`no ${slice} jobs under ${objectsDir}.`);
  return plan;
}

interface SpendLine {
  at: string;
  model: string;
  slice: SnapshotSlice;
  tokens: number;
  usd: number;
}

function spendLogPath(workDir: string): string {
  return join(workDir, "spend.jsonl");
}

/** Every billed request recorded under `workDir`, across models and runs. */
export function readSpend(workDir: string): SpendLine[] {
  let text: string;
  try {
    text = readFileSync(spendLogPath(workDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as SpendLine);
}

/** One model's measured tokens and list-price cost. */
export function modelSpend(workDir: string, slug: string): { tokens: number; usd: number } {
  const lines = readSpend(workDir).filter((l) => l.model === slug);
  return {
    tokens: lines.reduce((sum, l) => sum + l.tokens, 0),
    usd: lines.reduce((sum, l) => sum + l.usd, 0),
  };
}

export interface EmbedRunOptions {
  objectsDir: string;
  workDir: string;
  slice: SnapshotSlice;
  model: SnapshotModel;
  /** The approved total, USD at list prices, across every model and run recorded under `workDir`. */
  maxUsd: number;
  /** Requests in flight at once (default 4). */
  concurrency?: number;
  log?: (line: string) => void;
  /** Test seam for the retry backoff. */
  sleep?: (ms: number) => Promise<void>;
}

export interface EmbedRunResult {
  /** `stopped_at_cap`: the guard refused a request; finished chunks are kept, no vectors parts written. */
  status: "complete" | "stopped_at_cap";
  jobs: number;
  uniqueTexts: number;
  chunksReused: number;
  chunksEmbedded: number;
  /** This run's billed tokens and their list-price cost. */
  tokens: number;
  usd: number;
}

export async function embedSlice(opts: EmbedRunOptions): Promise<EmbedRunResult> {
  const { objectsDir, workDir, slice, model } = opts;
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const chunkDir = join(workDir, model.slug, slice);
  mkdirSync(chunkDir, { recursive: true });

  const plan = planSlice(objectsDir, slice);
  const result: EmbedRunResult = {
    status: "complete",
    jobs: plan.jobs,
    uniqueTexts: plan.hashes.length,
    chunksReused: 0,
    chunksEmbedded: 0,
    tokens: 0,
    usd: 0,
  };

  // A chunk file is named after the texts it holds and the model and host that embedded them, so a
  // chunk from another plan, or from the same model on another host, is never reused.
  const chunkCount = Math.ceil(plan.hashes.length / CHUNK_TEXTS);
  const chunkName = (c: number) => {
    const hashes = plan.hashes.slice(c * CHUNK_TEXTS, (c + 1) * CHUNK_TEXTS);
    const name = sha256Hex([model.id, model.host, ...hashes].join("\n")).slice(0, 24);
    return { file: `chunk-${name}.f32`, texts: hashes.length };
  };
  const rowBytes = model.dimensions * 4;

  // Re-read at every chunk, so spend another process records under the same work folder (the owner
  // running the reference while the challengers run here) counts against the cap too.
  const recordedUsd = () => readSpend(workDir).reduce((sum, l) => sum + l.usd, 0);
  let recorded = recordedUsd();
  let sinceRead = 0;
  let reserved = 0;
  let capHit = false;
  const reader = partReader(objectsDir, plan);

  for (let c = 0; c < chunkCount && !capHit; c++) {
    const { file, texts: textCount } = chunkName(c);
    if (objectSize(chunkDir, file) === textCount * rowBytes) {
      result.chunksReused++;
      continue;
    }
    recorded = recordedUsd();
    sinceRead = 0;

    const texts = Array.from({ length: textCount }, (_x, i) => reader.text(c * CHUNK_TEXTS + i));
    const batches = [...chunkByLimits(texts, model.limits)];
    const vectors: number[][][] = new Array<number[][]>(batches.length);
    let next = 0;

    const worker = async () => {
      while (!capHit) {
        const b = next++;
        const batch = batches[b];
        if (batch === undefined) return;
        const estimate = modelCostUsd(model, estimateTokens(batch, model.limits.charsPerToken));
        if (recorded + sinceRead + reserved + estimate > opts.maxUsd) {
          capHit = true;
          return;
        }
        reserved += estimate;
        try {
          const res = await withRetry(() => model.embedBatch(batch, "document"), sleep, log);
          const listUsd = modelCostUsd(model, res.totalTokens);
          const usd = res.costUsd ?? listUsd;
          appendSpend(workDir, { model: model.slug, slice, tokens: res.totalTokens, usd });
          result.tokens += res.totalTokens;
          result.usd += usd;
          sinceRead += usd;
          // Recorded first, then refused: a request billed above the list price (a host's priority
          // tier) means the pin isn't what the cost estimate assumed.
          if (usd > listUsd * 1.05) {
            throw new Error(
              `${model.slug}: a request was billed $${usd.toFixed(6)} for ${res.totalTokens} tokens, ` +
                `above the list price ($${listUsd.toFixed(6)}). Stopping.`,
            );
          }
          vectors[b] = res.embeddings;
        } finally {
          reserved -= estimate;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
    if (capHit) break;

    writeObject(chunkDir, file, encodeVectors(vectors.flat(), model.dimensions));
    result.chunksEmbedded++;
    log(
      `[${model.slug} ${slice}] chunk ${c + 1}/${chunkCount} embedded; ` +
        `run ${result.tokens} tokens, $${result.usd.toFixed(4)}; ` +
        `all models $${(recorded + sinceRead).toFixed(4)} of $${opts.maxUsd.toFixed(2)}`,
    );
  }

  if (capHit) {
    result.status = "stopped_at_cap";
    log(
      `[${model.slug} ${slice}] STOPPED at the spend cap: $${recordedUsd().toFixed(4)} recorded of ` +
        `$${opts.maxUsd.toFixed(2)} approved. Finished chunks are kept; re-run with a higher --max-usd to continue.`,
    );
    return result;
  }

  // Every chunk is on disk: write the vectors part aligned to each jobs part.
  const chunkRow = chunkRowReader(chunkDir, (c) => chunkName(c).file, rowBytes);
  try {
    for (const part of plan.parts) {
      const block = new Uint8Array(part.textOf.length * rowBytes);
      part.textOf.forEach((index, row) => {
        // A job with no text at all keeps an all-zero vector (flagged blank_description + short_title).
        if (index >= 0) block.set(chunkRow(index), row * rowBytes);
      });
      writeObject(objectsDir, vectorsPartPath(model.slug, part.path), block);
    }
  } finally {
    chunkRow.close();
  }
  log(
    `[${model.slug} ${slice}] complete: ${plan.jobs} jobs, ${plan.hashes.length} distinct texts, ` +
      `${result.chunksEmbedded} chunk(s) embedded, ${result.chunksReused} reused.`,
  );
  return result;
}

function appendSpend(workDir: string, line: Omit<SpendLine, "at">): void {
  mkdirSync(workDir, { recursive: true });
  appendFileSync(
    spendLogPath(workDir),
    `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`,
  );
}

/** The chunker's own (deliberately high) token estimate, so the guard errs toward stopping early. */
function estimateTokens(texts: string[], charsPerToken: number): number {
  return texts.reduce((sum, t) => sum + Math.ceil(utf8.encode(t).length / charsPerToken), 0);
}

/** Retry a request the provider didn't reject outright (429, 5xx, a timeout), with backoff. A failed
 *  request isn't billed, so only the successful attempt reaches the spend log. */
async function withRetry<T>(
  request: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  log: (line: string) => void,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await request();
    } catch (err) {
      if (err instanceof EmbeddingRejectedError || attempt === MAX_ATTEMPTS) throw err;
      const waitMs = Math.min(2 ** attempt, MAX_WAIT_S) * 1000;
      log(
        `  request failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${waitMs / 1000}s: ${errorLine(err)}`,
      );
      await sleep(waitMs);
    }
  }
}

function errorLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0]?.slice(0, 500) ?? "";
}

/** Reads a distinct text back from the jobs part it first appears in, keeping two parts in memory
 *  (a chunk's texts sit in consecutive parts). */
function partReader(objectsDir: string, plan: EmbedPlan) {
  const cache = new Map<number, SnapshotJob[]>();
  return {
    text(index: number): string {
      const seen = plan.firstSeen[index];
      const path = seen && plan.parts[seen.part]?.path;
      if (!seen || !path) throw new Error(`no source row for distinct text ${index}.`);
      let jobs = cache.get(seen.part);
      if (!jobs) {
        if (cache.size >= 2) cache.delete(cache.keys().next().value as number);
        jobs = readJobsPart(objectsDir, path);
        cache.set(seen.part, jobs);
      }
      return snapshotEmbedText(jobs[seen.row] as SnapshotJob).text;
    },
  };
}

/** Reads one distinct text's vector from its chunk file, keeping a few chunk files open. */
function chunkRowReader(chunkDir: string, fileOf: (chunk: number) => string, rowBytes: number) {
  const open = new Map<number, number>();
  const read = (index: number): Uint8Array => {
    const chunk = Math.floor(index / CHUNK_TEXTS);
    let fd = open.get(chunk);
    if (fd === undefined) {
      if (open.size >= 16) {
        const oldest = open.keys().next().value as number;
        closeSync(open.get(oldest) as number);
        open.delete(oldest);
      }
      fd = openSync(join(chunkDir, fileOf(chunk)), "r");
      open.set(chunk, fd);
    }
    const row = new Uint8Array(rowBytes);
    const got = readSync(fd, row, 0, rowBytes, (index % CHUNK_TEXTS) * rowBytes);
    if (got !== rowBytes)
      throw new Error(`short read for distinct text ${index} in ${fileOf(chunk)}.`);
    return row;
  };
  read.close = () => {
    for (const fd of open.values()) closeSync(fd);
    open.clear();
  };
  return read;
}
