/**
 * Unit suite for the embed-backlog drain loop (src/backfill.ts `embedDrainStep`). NO creds, NO Neon, NO
 * Voyage — a recording fake `step` and a stubbed `embedNextPage` (the page body itself runs against PGlite
 * in packages/db/src/repos/embeddings.integration.test.ts) drive it.
 * Locks: empty backlog / short last-page → drained:true; a full page continues; a vector/batch length
 * mismatch → NonRetriableError (don't burn paid retries) while other errors stay retriable; the page cap →
 * drained:false; and the step ids derive from the loop index only (never ctx.attempt).
 */
import { NonRetriableError } from "inngest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmbedCountMismatchError } from "@opusfinder/db/repos";

import { recordingStep } from "@test/inngest/stubs";
import { rejectionOf, rejectionReasonOf } from "@test/rejection";

const repos = vi.hoisted(() => ({ embedNextPage: vi.fn() }));
vi.mock("@opusfinder/db/repos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opusfinder/db/repos")>()),
  embedNextPage: repos.embedNextPage,
}));

import { embedDrainStep, type BackfillDeps } from "./backfill";

/** One page's result: `n` rows embedded at 10 tokens each; `done` when the page came back short. */
function page(n: number, done = n < 64): { embedded: number; tokens: number; done: boolean } {
  return { embedded: n, tokens: n * 10, done };
}

const deps: BackfillDeps = { db: {} as never, embed: vi.fn() };

beforeEach(() => {
  repos.embedNextPage.mockReset();
});

describe("embedDrainStep", () => {
  it("drains immediately on an empty backlog — one page", async () => {
    repos.embedNextPage.mockResolvedValueOnce(page(0));
    const { runs, tools } = recordingStep();

    const r = await embedDrainStep(deps, tools);

    expect(r).toEqual({ pages: 1, processed: 0, tokens: 0, drained: true });
    expect(runs).toEqual(["embed-page-0"]);
  });

  it("drains on a short (<EMBED_PAGE) last page", async () => {
    repos.embedNextPage.mockResolvedValueOnce(page(10));
    const { runs, tools } = recordingStep();

    const r = await embedDrainStep(deps, tools);

    expect(r).toEqual({ pages: 1, processed: 10, tokens: 100, drained: true });
    expect(runs).toEqual(["embed-page-0"]);
  });

  it("continues past a full page, then drains on the following empty page", async () => {
    repos.embedNextPage.mockResolvedValueOnce(page(64)).mockResolvedValueOnce(page(0));
    const { runs, tools } = recordingStep();

    const r = await embedDrainStep(deps, tools);

    expect(r).toEqual({ pages: 2, processed: 64, tokens: 640, drained: true });
    expect(runs).toEqual(["embed-page-0", "embed-page-1"]); // ids from the loop index
  });

  it("fails terminally with NonRetriableError on a vector/batch length mismatch", async () => {
    repos.embedNextPage.mockRejectedValueOnce(new EmbedCountMismatchError(63, 64));
    const { tools } = recordingStep();

    const err = await rejectionOf(embedDrainStep(deps, tools));

    expect(err).toBeInstanceOf(NonRetriableError);
    expect(err.message).toMatch(/embed returned 63 vectors for 64 jobs/);
  });

  it("rethrows any other page error unwrapped, so Inngest still retries a transient Voyage failure", async () => {
    const transient = new Error("voyage 503");
    repos.embedNextPage.mockRejectedValueOnce(transient);
    const { tools } = recordingStep();

    expect(await rejectionReasonOf(embedDrainStep(deps, tools))).toBe(transient);
  });

  it("stops at the page cap with drained:false on a deep backlog", async () => {
    repos.embedNextPage.mockResolvedValue(page(64)); // ALWAYS full → never done
    const { runs, tools } = recordingStep();

    const r = await embedDrainStep(deps, tools);

    expect(r.drained).toBe(false);
    expect(r.pages).toBe(200); // MAX_PAGES_PER_RUN
    expect(runs).toHaveLength(200);
    expect(runs[0]).toBe("embed-page-0");
    expect(runs[199]).toBe("embed-page-199");
    expect(r.processed).toBe(200 * 64);
    expect(r.tokens).toBe(200 * 640);
  });
});
