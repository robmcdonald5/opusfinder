/**
 * Unit suite for the embed-backlog drain loop (src/backfill.ts `embedDrainStep`). NO creds, NO Neon, NO
 * Voyage — a recording fake `step`, a stubbed `@opusfinder/db/repos`, and an injected fake embedder drive it.
 * Locks: empty backlog / short last-page → drained:true; a full page continues; a vector/batch length
 * mismatch → NonRetriableError (no write, don't burn paid retries); the page cap → drained:false; and the
 * step ids derive from the loop index only (never ctx.attempt).
 */
import { NonRetriableError } from "inngest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { recordingStep } from "@test/inngest/stubs";
import { rejectionOf } from "@test/rejection";

const repos = vi.hoisted(() => ({
  jobsNeedingEmbedding: vi.fn(),
  jobEmbeddingText: vi.fn((job: { id: number }) => `text-${job.id}`),
  writeJobEmbeddings: vi.fn(),
}));
vi.mock("@opusfinder/db/repos", () => repos);

import { embedDrainStep, type BackfillDeps } from "./backfill";

/** A fake embedder: returns `vectorCount ?? texts.length` vectors and `texts.length * 10` tokens. */
function fakeEmbed(vectorCount?: number): BackfillDeps["embed"] {
  return vi.fn(async (texts: string[]) => ({
    embeddings: Array.from({ length: vectorCount ?? texts.length }, (_v, i) => [i]),
    usage: { totalTokens: texts.length * 10 },
  }));
}

/** A backlog page of `n` jobs (only `id` is read — jobEmbeddingText is stubbed). */
function jobs(n: number): { id: number }[] {
  return Array.from({ length: n }, (_v, i) => ({ id: i + 1 }));
}

function deps(embed: BackfillDeps["embed"]): BackfillDeps {
  return { db: {} as never, embed };
}

beforeEach(() => {
  repos.jobsNeedingEmbedding.mockReset();
  repos.writeJobEmbeddings.mockReset();
  repos.writeJobEmbeddings.mockImplementation(async (_db: unknown, rows: unknown[]) => rows.length);
});

describe("embedDrainStep", () => {
  it("drains immediately on an empty backlog — one page, no embed call", async () => {
    repos.jobsNeedingEmbedding.mockResolvedValueOnce([]);
    const embed = fakeEmbed();
    const { runs, tools } = recordingStep();

    const r = await embedDrainStep(deps(embed), tools);

    expect(r).toEqual({ pages: 1, processed: 0, tokens: 0, drained: true });
    expect(runs).toEqual(["embed-page-0"]);
    expect(embed).not.toHaveBeenCalled();
    expect(repos.writeJobEmbeddings).not.toHaveBeenCalled();
  });

  it("drains on a short (<EMBED_PAGE) last page", async () => {
    repos.jobsNeedingEmbedding.mockResolvedValueOnce(jobs(10));
    const embed = fakeEmbed();
    const { runs, tools } = recordingStep();

    const r = await embedDrainStep(deps(embed), tools);

    expect(r).toEqual({ pages: 1, processed: 10, tokens: 100, drained: true });
    expect(runs).toEqual(["embed-page-0"]);
    expect(repos.writeJobEmbeddings).toHaveBeenCalledTimes(1);
  });

  it("continues past a full page, then drains on the following empty page", async () => {
    repos.jobsNeedingEmbedding.mockResolvedValueOnce(jobs(64)).mockResolvedValueOnce([]);
    const embed = fakeEmbed();
    const { runs, tools } = recordingStep();

    const r = await embedDrainStep(deps(embed), tools);

    expect(r).toEqual({ pages: 2, processed: 64, tokens: 640, drained: true });
    expect(runs).toEqual(["embed-page-0", "embed-page-1"]); // ids from the loop index
  });

  it("fails terminally with NonRetriableError on a vector/batch length mismatch — no write", async () => {
    repos.jobsNeedingEmbedding.mockResolvedValueOnce(jobs(64));
    const embed = fakeEmbed(63); // 63 vectors for 64 jobs
    const { tools } = recordingStep();

    const err = await rejectionOf(embedDrainStep(deps(embed), tools));

    expect(err).toBeInstanceOf(NonRetriableError);
    expect(err.message).toMatch(/embed returned 63 vectors for 64 jobs/);
    expect(repos.writeJobEmbeddings).not.toHaveBeenCalled();
  });

  it("stops at the page cap with drained:false on a deep backlog", async () => {
    repos.jobsNeedingEmbedding.mockResolvedValue(jobs(64)); // ALWAYS full → never done
    const embed = fakeEmbed();
    const { runs, tools } = recordingStep();

    const r = await embedDrainStep(deps(embed), tools);

    expect(r.drained).toBe(false);
    expect(r.pages).toBe(200); // MAX_PAGES_PER_RUN
    expect(runs).toHaveLength(200);
    expect(runs[0]).toBe("embed-page-0");
    expect(runs[199]).toBe("embed-page-199");
    expect(r.processed).toBe(200 * 64);
    expect(r.tokens).toBe(200 * 640);
  });
});
