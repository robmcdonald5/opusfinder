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
pnpm eval:hnsw                                  # HNSW-vs-exact recall on real Neon (read-only)

pnpm exec vitest run packages/eval/src              # self-tests: metrics/cosine/dataset/report (Vitest)
pnpm --filter @opusfinder/eval export:candidates    # dump real jobs from Neon (labeling aid)
pnpm --filter @opusfinder/eval build:pool           # per-profile candidate pools from Neon (3 arms)
pnpm --filter @opusfinder/eval build:dataset        # regenerate dataset.jsonl (legacy + pooled)
```

`pnpm eval` writes a committed report per `(ranker, embedder, dataset)` under `reports/` and
prints the delta vs the last committed run. Reports are deterministic (no timestamp) so an
unchanged run is a byte-identical file — the diff is signal, not noise.

## Metrics

Binary relevance (`expectedGoodIds`): precision@k, recall@k, NDCG@k at k ∈ {3, 5, 10}, averaged
across examples. Recall/NDCG are undefined (and dropped from the mean) for an example with no
relevant ids. The math is pinned by `src/metrics.test.ts` (+ `cosine`/`dataset`/`report` tests).

## HNSW recall (plan §8)

`pnpm eval:hnsw` measures how much of the EXACT cosine top-k the pgvector HNSW index returns on
the real Neon corpus — a read-only MEASUREMENT (not a pass/fail), written to
`reports/hnsw-recall.dataset.json`. Each leg is planner-forced over the tx-capable neon-serverless driver
and EXPLAIN-verified (the ANN leg must use the index, the exact leg must not), so it can never
silently score exact-vs-exact. Recall is tie-aware on distance (`src/ann.ts`), because
same-signature cross-posts carry identical embeddings. Production currently seq-scans (exact —
neon-http can't hold `SET LOCAL hnsw.ef_search`; see repos/retrieval.ts), so this quantifies the
cliff retrieval inherits if scale ever flips the planner to the index: at the default
`ef_search=40` the production-filtered shape under-fills catastrophically (single-digit rows of
the 150 fetched). Needs `DATABASE_URL` + `VOYAGE_API_KEY`.

## Dataset

`data/dataset.jsonl` — one `EvalExample` (`{ profile, candidateJobs[], expectedGoodIds[] }`) per
line, validated at load (`src/dataset.ts`). It is **frozen/hermetic**: candidate job text is
snapshotted, not read live from the DB, so metrics don't drift as `jobs` changes. `data/fixture.jsonl`
is a tiny synthetic, non-PII set for smoke tests.

Two example shapes coexist:

- **Legacy (2 seed examples)** — labeled against the FULL board of the original ~80-job corpus;
  frozen verbatim in `data/legacy-examples.jsonl` and passed through `build:dataset` untouched.
- **Pooled (the scale shape)** — at the ~100k-job corpus a full board is unlabelable, so each
  example's `candidateJobs` is the union of three nomination arms (`scripts/build-pool.ts`):
  production retrieval (Voyage query embedding through `retrieveCandidatesForProfile`), a
  Postgres full-text arm (target roles + skills), and a seeded random arm — multi-arm so the
  labels aren't circular in the production ranker's favor. **Labels are honest only WITHIN each
  example's pool**: unlabeled ≠ irrelevant, so never compute full-corpus labeled recall from
  pool-scoped labels.

Build flow: profiles + owner-authoritative labels live in `data/profiles/<id>.json` (committed)
→ `build:pool` snapshots each profile's candidate pool to `data/pools/<id>.json` (gitignored)
→ `build:dataset` assembles legacy + pooled examples into `dataset.jsonl`. Rebuilding a pool
against a changed corpus shifts pool ids; `build:dataset` then fails loud on stale labels
(forcing a relabel) instead of silently rescoring them.

### Profiles, labels, and PII

Profiles are an **eval-time stand-in** for the Phase-9 `user_profiles` row. Every profile is
derived from a real CV — the 2 seed profiles from the owners' own CVs, the pooled profiles from
the CC0 Kaggle "Resume Dataset" (snehaanbhawal; source-anonymized LiveCareer resumes, pulled via
the `opensporks/resumes` HF mirror) — and is **anonymized** — no names, contact info, employers,
schools, or URLs; only summary / skills / target roles. Raw CVs live in `data/cvs/` and are
**gitignored** (never committed), as are the `candidates-export.json` / `data/pools/` working
artifacts and `.env`.

Labels are agent-drafted; the labeling authority (the CV owner for the seed profiles, the repo
owner for the dataset-derived ones) refines `goodIds` in `data/profiles/<id>.json` and re-runs
`build:dataset`. Scale the set toward the spec's ~50 examples via public CV datasets
(Kaggle/HuggingFace) + more ATS boards as adapters land.

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

## Keys

- `OPENAI_API_KEY` → `packages/eval/.env` (this package; for the comparison).
- `VOYAGE_API_KEY` / `DATABASE_URL` are read from the embeddings/db packages (Phase 4/0).
