# @opusfinder/eval

The matching-quality eval harness (Phase 5). It scores a **ranking** of candidate jobs for a
profile against a labeled relevance set, so every later change to retrieval, the LLM rerank
(Phase 10), or the embedding model can be replayed and compared before it ships. Quality
regressions are the failure mode this product can't recover from, so this is built early and
grown continuously.

Central idea: vector retrieval and the LLM rerank both emit a ranking, so **one** metrics core
scores both — they differ only in the `Ranker`. The Voyage-vs-OpenAI embedding comparison falls
out for free: the embedding ranker is parameterized by an `Embedder`, so swapping providers is a
one-argument change.

## Commands

```bash
pnpm eval                                       # random baseline over the real dataset
pnpm eval -- --ranker embedding --embedder voyage   # vector retrieval (Voyage)
pnpm eval -- --ranker embedding --embedder openai   # vector retrieval (OpenAI)
pnpm eval -- --ranker llm-rerank                 # shared LLM rerank core (deterministic stub)
pnpm eval -- --dataset data/fixture.jsonl       # synthetic smoke test (no DB/network)
pnpm eval:compare                               # Voyage vs OpenAI, side-by-side retrieval@k
pnpm eval:extraction                            # F4 per-field extraction-accuracy (keyless stub; -- --live for Haiku)

pnpm --filter @opusfinder/eval test:metrics         # self-test of the metrics math + loader
pnpm --filter @opusfinder/eval export:candidates    # dump real jobs from Neon (labeling aid)
pnpm --filter @opusfinder/eval build:dataset        # regenerate dataset.jsonl from the export
```

`pnpm eval` writes a committed report per `(ranker, embedder, dataset)` under `reports/` and
prints the delta vs the last committed run. Reports are deterministic (no timestamp) so an
unchanged run is a byte-identical file — the diff is signal, not noise.

## Metrics

Binary relevance (`expectedGoodIds`): precision@k, recall@k, NDCG@k at k ∈ {3, 5, 10}, averaged
across examples. Recall/NDCG are undefined (and dropped from the mean) for an example with no
relevant ids. The math is pinned by `scripts/test-metrics.ts`.

## Dataset

`data/dataset.jsonl` — one `EvalExample` (`{ profile, candidateJobs[], expectedGoodIds[] }`) per
line, validated at load (`src/dataset.ts`). It is **frozen/hermetic**: candidate job text is
snapshotted, not read live from the DB, so metrics don't drift as `jobs` changes. `data/fixture.jsonl`
is a tiny synthetic, non-PII set for smoke tests.

Build flow: `export:candidates` dumps real jobs → `build:dataset` assembles examples from the
export + the profiles/labels in `scripts/build-dataset.ts`.

### Profiles, labels, and PII

Profiles are an **eval-time stand-in** for the Phase-9 `user_profiles` row. The seed profiles are
derived from real CVs and are **anonymized** — no names, contact info, employers, schools, or
URLs; only summary / skills / target roles. Raw CVs live in `data/cvs/` and are **gitignored**
(never committed), as is the `candidates-export.json` working artifact and `.env`.

Labels are agent-drafted; the CV owner is the authority and may refine `expectedGoodIds` directly
in `dataset.jsonl` (or in `build-dataset.ts` and re-run). Scale the set toward the spec's ~50
examples via public CV datasets (Kaggle/HuggingFace) + more ATS boards as adapters land.

## Status (Phase 5)

- Harness, metrics, random baseline, embedding ranker, `pnpm eval` + reports: **done**.
- Voyage `voyage-3-large` retrieval validated on the real seed set (NDCG@10 ≈ 83% vs random ≈ 9%).
- **Voyage-vs-OpenAI comparison: done → Voyage wins** (NDCG@10 83.2% vs OpenAI
  `text-embedding-3-small` 66.9% on the seed set), so Voyage is the chosen provider. The harness
  is provider-agnostic — `pnpm eval:compare` reproduces the head-to-head, and `--embedder` swaps
  providers in one argument. Verdict + caveats in `research/specs/OPEN_DECISIONS.md`; re-decide
  when the labeled set scales (~50 examples).

## LLM rerank (Phase 10)

`src/types.ts` defines `Ranker`. The Phase-10 LLM rerank landed here as the `llm-rerank` ranker
(`src/rankers/llm-rerank.ts`): it runs the **shared** `rerankCandidates` from `@opusfinder/rerank` —
the SAME core the digest pipeline runs — through a deterministic stub call (seeded RNG in `src/rng.ts`,
so the report is reproducible). `pnpm eval -- --ranker llm-rerank` writes
`reports/llm-rerank.dataset.json`, so eval scores exactly what production reranks. (The synthesis
"why matched" contract is exercised in the pipeline, not scored here.)

## Extraction accuracy (Phase F4)

Distinct from the ranking metrics above (a different shape, not a `Ranker`): `src/extraction.ts` +
`scripts/eval-extraction.ts` (`pnpm eval:extraction`) score the Phase-F4 job-enrichment extractor field-by-field
as a **confusion matrix** — per field: correctly-null / hallucinated-when-absent / wrong-value / missed /
correct. The **hallucinated-when-absent** rate is the gate for the deferred F4-FILTER, since a deterministic
filter would trust these columns literally. It runs the SAME injected extractor the backfill uses
(`makeJobEnrichmentExtractor`) against `data/extraction-fixtures.jsonl` (hand-labeled real prose); keyless
deterministic stub by default, `-- --live` for real Haiku (`--model sonnet` for the F4-MODEL spot-check).
Latest live run: salary 0% hallucination / 100% accuracy, YoE ~94% accuracy. This is an accuracy eval, not a
ranker — its `reports/extraction-*.json` is a gitignored run artifact, not a committed ranking baseline.

## Keys

- `OPENAI_API_KEY` → `packages/eval/.env` (this package; for the comparison).
- `VOYAGE_API_KEY` / `DATABASE_URL` are read from the embeddings/db packages (Phase 4/0).
