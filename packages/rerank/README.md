# @opusfinder/rerank

The pure, shared **listwise rerank core** (Phase 10): turn a user profile + a candidate job pool into a
ranked ordering by asking an LLM to *score* each candidate for relevance. This package owns only the
orchestration and the prompt **skeleton** — the stable scoring rubric, composing the per-user profile
into one cacheable `system` string, chunking the candidates, merging per-chunk scores into a global
order, and backfilling omitted ids into a full permutation. The actual LLM round-trip is **injected**.

## Why a separate package (the injection)

The LLM call is a `RerankCall` parameter, so this module depends ONLY on `@opusfinder/shared` types —
**no `@opusfinder/llm`, no db, no Inngest** at the top level (`pnpm guard:worker` and the dependency
graph both stay clean). That injection is the whole point: the **same** `rerankCandidates` runs in two
places —

- the **digest pipeline** (`@opusfinder/inngest`) wires `call` to a real Haiku `generateObject` with
  `cacheSystem`, so the cached rubric+profile prefix is reused across chunks;
- the **eval harness** (`@opusfinder/eval`) wires a deterministic stub (and can wire the real Haiku
  call too),

so eval scores **exactly** what production runs. It mirrors the `embeddingRanker(embed)` injection
blueprint already used in `packages/eval`.

## Public surface (`src/index.ts`)

- `rerankCandidates(profile, candidates, call, opts?)` → `{ orderedIds, scores }`. Builds the system
  once (with `opts.prefs?: PromptPreferences`, built once and reused across chunks — **no new
  cache-miss axis**), scores candidates in chunks of `opts.chunkSize` (default `DEFAULT_CHUNK_SIZE =
  13`, the spec's
  "10–20 per call"), then returns a **best-first ordering of all input ids**. Scored candidates sort by
  score desc (ties → original order); any id the call omitted is backfilled at the end in original
  order — the result is ALWAYS a full permutation, which eval's `assertPermutation` requires and the
  digest's top-K slice relies on. Scores are clamped into `[0,1]` and non-finite scores are dropped
  (so a malformed call can't poison the sort or land junk in `digest_items.score`); ids not in the
  scored chunk are ignored (no hallucinated ids).
- `buildRerankSystem(profile, prefs?: PromptPreferences)` — composes the cacheable `system`:
  `RERANK_RUBRIC` + the candidate profile via the shared `composeProfileText` (the **same** text the
  profile embedding is built from, so the reranker reasons over the representation retrieval uses) +,
  when `prefs` is set, a `=== Candidate stated preferences ===` block from `composePromptPrefs`
  appended to the cached system. The candidate list is deliberately NOT here — it's the variable
  per-chunk tail the injected call renders, keeping this prefix stable and cacheable.
- `RERANK_RUBRIC` — the stable scoring rubric (the cached prefix). Scores on an absolute **0.0–1.0**
  scale with explicit bands, signal weighting (skills > target-role > seniority > domain), a seniority
  ladder, role families, calibration examples, and common-mistake guards. F3 adds three carve-outs: a
  **conditional salary tiebreaker** (salary was previously hard-barred from scoring), a **declared YoE
  band overrides the level inferred from the summary** clause, and a **bounded dealbreakers** clause.
- Types: `RerankCandidate` (`{ id, title, descriptionText }` — the digest's `JobCandidate` and the
  eval `EvalJob` are both structurally assignable), `RerankScore`, `RerankCall`, `RerankResult`.

## Cache-size note (load-bearing for the digest gate)

The Phase-10 acceptance gate requires the rerank prompt cache to engage (`rerankCacheReadTokens > 0`).
A model only caches a prefix above a minimum size (**Haiku ≈ 4096 tokens**); a thin rubric silently
no-ops the cache and fails the gate. `RERANK_RUBRIC` is written long **on purpose** — a richer rubric
both scores better and clears that floor. It's verified live (the digest run observes
`cache.readInputTokens`); if a model bumps its minimum, extend the rubric rather than padding with
filler.

## Tests

The eval harness is the test: `pnpm eval -- --ranker llm-rerank` runs `rerankCandidates` through the
deterministic stub and writes `packages/eval/reports/llm-rerank.dataset.json` (P/R/NDCG@k);
`assertPermutation` passing is the proof the backfill keeps the output a full permutation.

`pnpm test:prefs` is the F3 smoke: it asserts the `composePromptPrefs` block lands in the cached
`buildRerankSystem` output when `prefs` is passed (and is absent when it isn't).
