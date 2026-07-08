import { describe, expect, it, vi } from "vitest";

import type { Embedder, EmbedInputType } from "../embedders/types";
import type { EvalJob, EvalProfile } from "../types";
import { embeddingRanker } from "./embedding";

// Leaf pure-unit with an INJECTED fake embedder — no Voyage/OpenAI, no network. Locks the two
// load-bearing behaviors of the vector ranker: (1) it orders candidates by cosine similarity to the
// profile "query" (descending), the same computation the digest runs over pgvector; (2) it embeds each
// distinct DOCUMENT text exactly once per ranker instance — the per-closure cache that removes the
// dominant paid-token cost when a job recurs across examples. The fake encodes each text's vector in a
// `[[v:..]]` marker so the test controls similarity without re-deriving the composer's exact output, and
// the profile is always re-embedded as a "query" (Voyage's query/document asymmetry).

const VEC_MARKER = /\[\[v:([-\d.,]+)\]\]/;

function parseVec(text: string): number[] {
  const m = VEC_MARKER.exec(text);
  if (!m) throw new Error(`fake embedder: no vector marker in ${JSON.stringify(text)}`);
  return (m[1] as string).split(",").map(Number);
}

/** A fake `Embedder` that returns the vector encoded in each text's marker, recording every call. */
function makeFakeEmbedder(): ReturnType<typeof vi.fn> & Embedder {
  return vi.fn(async (texts: string[], _inputType: EmbedInputType) =>
    texts.map(parseVec),
  ) as unknown as ReturnType<typeof vi.fn> & Embedder;
}

const profile: EvalProfile = {
  id: "backend-ic-1",
  summary: "Senior backend engineer [[v:1,0]]",
  skills: ["Go"],
  targetRoles: ["Backend Engineer"],
};

// Cosines vs the query [1,0]: A=1.0, C≈0.707 ([2,2]), B=0.0 ([0,1]) → A, C, B regardless of input order.
const pool: readonly EvalJob[] = [
  { id: 1, title: "A", descriptionText: "aligned [[v:1,0]]" },
  { id: 2, title: "B", descriptionText: "orthogonal [[v:0,1]]" },
  { id: 3, title: "C", descriptionText: "diagonal [[v:2,2]]" },
];

const documentCalls = (embed: ReturnType<typeof vi.fn>): string[][] =>
  embed.mock.calls.filter(([, inputType]) => inputType === "document").map(([texts]) => texts);

const queryCalls = (embed: ReturnType<typeof vi.fn>): string[][] =>
  embed.mock.calls.filter(([, inputType]) => inputType === "query").map(([texts]) => texts);

describe("embeddingRanker", () => {
  it("orders candidates by cosine similarity to the profile query (descending)", async () => {
    const embed = makeFakeEmbedder();
    const ranked = await embeddingRanker(embed)(profile, [...pool]);
    expect(ranked).toEqual([1, 3, 2]);
  });

  it("embeds the profile as a 'query' and the jobs as 'document'", async () => {
    const embed = makeFakeEmbedder();
    await embeddingRanker(embed)(profile, [...pool]);
    expect(queryCalls(embed)).toHaveLength(1);
    // Three distinct job texts, composed `title\n\ndesc`, in candidate order → one document embed call.
    expect(documentCalls(embed).flat()).toEqual([
      "A\n\naligned [[v:1,0]]",
      "B\n\northogonal [[v:0,1]]",
      "C\n\ndiagonal [[v:2,2]]",
    ]);
  });

  it("caches document vectors across invocations — a recurring job is embedded once", async () => {
    const embed = makeFakeEmbedder();
    const ranker = embeddingRanker(embed);
    await ranker(profile, [...pool]);
    await ranker(profile, [...pool]);
    // The query is re-embedded every call; the documents are embedded ONLY on the first.
    expect(queryCalls(embed)).toHaveLength(2);
    expect(documentCalls(embed)).toHaveLength(1);
    expect(documentCalls(embed).flat()).toHaveLength(3);
  });

  it("dedupes identical document texts within a single call", async () => {
    const embed = makeFakeEmbedder();
    const dupes: EvalJob[] = [
      { id: 10, title: "Dup", descriptionText: "same [[v:1,0]]" },
      { id: 11, title: "Dup", descriptionText: "same [[v:1,0]]" },
    ];
    await embeddingRanker(embed)(profile, dupes);
    // Both jobs compose to identical text → the embedder sees that document text once.
    expect(documentCalls(embed).flat()).toEqual(["Dup\n\nsame [[v:1,0]]"]);
  });

  it("throws when a candidate composes to empty document text (validator drift guard)", async () => {
    const embed = makeFakeEmbedder();
    const blank: EvalJob[] = [{ id: 99, title: "", descriptionText: "" }];
    await expect(embeddingRanker(embed)(profile, blank)).rejects.toThrow(
      /candidate job 99 composes to empty text/,
    );
  });

  it("throws when the embedder returns fewer document vectors than requested (provider/dimension bug)", async () => {
    // 3 distinct doc texts in, but the embedder hands back 2 — the count guard must fail loudly
    // rather than cache a short list and silently mis-score the dropped candidate.
    const short = vi.fn(async (texts: string[], inputType: EmbedInputType) =>
      inputType === "document" ? texts.slice(1).map(parseVec) : texts.map(parseVec),
    ) as unknown as Embedder;
    await expect(embeddingRanker(short)(profile, [...pool])).rejects.toThrow(
      /returned 2 vectors for 3 document texts/,
    );
  });

  it("throws when the embedder returns no vector for the profile", async () => {
    const empty = vi.fn(async (texts: string[], inputType: EmbedInputType) =>
      inputType === "query" ? [] : texts.map(parseVec),
    ) as unknown as Embedder;
    await expect(embeddingRanker(empty)(profile, [...pool])).rejects.toThrow(
      /no vector for the profile/,
    );
  });
});
