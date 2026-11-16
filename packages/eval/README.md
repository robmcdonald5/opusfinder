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
pnpm eval:locations                             # location normalizer vs the golden set (live model)

pnpm exec vitest run packages/eval/src              # self-tests: metrics/cosine/dataset/report (Vitest)
pnpm --filter @opusfinder/eval build:pool           # per-profile candidate pools from Neon (3 arms)
pnpm --filter @opusfinder/eval draft-labels         # draft each pool's labels + an owner review sheet
pnpm --filter @opusfinder/eval build:dataset        # regenerate dataset.jsonl (legacy + pooled)
```

`pnpm eval` writes a committed report per `(ranker, embedder, dataset)` under `reports/` and
prints the delta vs the last committed run. Reports are deterministic (no timestamp) so an
unchanged run is a byte-identical file — the diff is signal, not noise.

## Metrics

Binary relevance (`expectedGoodIds`): precision@k, recall@k, NDCG@k at k ∈ {3, 5, 10}, averaged
across examples. Recall/NDCG are undefined (and dropped from the mean) for an example with no
relevant ids. The math is pinned by `src/metrics.test.ts` (+ `cosine`/`dataset`/`report` tests).

## Location golden set

`data/locations-golden.jsonl` holds 368 real (company, location string) pairs pulled read-only from
production on 2026-10-19 (14 region-scoped ones added the same day), with each company's other strings as the production request shows them (up to
20, most-listed first). The pull was weighted toward the hard cases: bare names that could be several
places, office/HQ labels, company codes (`US-CA-Menlo Park`, `WBIR-TV Knoxville`), multi-place strings,
remote phrases and world regions; `category` records the bucket. Each pair's `expected` answer (GeoNames
place ids, remote countries, and areas by their names on the list in `@opusfinder/locations`) was drafted by a stronger model than the normalizer, working only from
`data/locations-golden.conventions.md` (never the normalizer's prompt), and resolved to GeoNames ids by
`pnpm --filter @opusfinder/eval run locations:label -- --drafts <file>` through the production check (where
the answer is a judgment between equally fair places, such as the nearest town to a site GeoNames doesn't
list, other place sets are added by hand as `alternatives`, and any of them counts). The
owner reviews them on the sheet `locations:review` writes to `data/reviews/locations-golden.md` (gitignored,
regenerated after a fix).

`pnpm eval:locations` runs the production prompt, schema, model and GeoNames check over the labeled pairs,
with and without the company context, and scores exact matches on the checked place ids + remote
countries (an expected area counts as its countries; an area off the list is a miss), overall, per category, and over the pairs the prompt doesn't quote. The check runs against a
local PGlite copy of the gazetteer built from the GeoNames files (`-- --geonames <dir>` to skip the
download), so it needs no database credential. Run it on demand and before any prompt or model change; it
writes `reports/locations.golden.json`. Not a CI gate: the model is live.

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
  a Voyage arm (retrieval.ts's filters and exact scan over a Voyage query embedding, with the geo
  and exclusion prefs left neutral so the pool nominates broadly), a Postgres full-text arm (target roles + skills), and a seeded random arm — multi-arm so the
  labels aren't circular in the production ranker's favor. **Labels are honest only WITHIN each
  example's pool**: unlabeled ≠ irrelevant, so never compute full-corpus labeled recall from
  pool-scoped labels.

Build flow: profiles + owner-authoritative labels live in `data/profiles/<id>.json` (committed)
→ `build:pool` snapshots each profile's candidate pool to `data/pools/<id>.json` (committed: a
pool can't be rebuilt once the corpus moves, and its labels mean nothing without it)
→ `draft-labels` judges that pool and writes drafted `goodIds` + a review sheet
→ `build:dataset` assembles legacy + pooled examples into `dataset.jsonl`. Rebuilding a labeled
profile's pool needs `--force` and means relabeling it (`draft-labels --force`): `build:dataset`
catches a good id that left the pool, not a new member nobody judged. A profile with no labels
drafted yet is SKIPPED (loudly) rather than emitted as an example nothing is relevant to.

### Profiles, labels, and PII

Profiles are an **eval-time stand-in** for the Phase-9 `user_profiles` row. Every profile is
derived from a real CV — the 2 seed profiles from the owners' own CVs, the pooled profiles from
the CC0 Kaggle "Resume Dataset" (snehaanbhawal; source-anonymized LiveCareer resumes, pulled via
the `opensporks/resumes` HF mirror) — and is **anonymized** — no names, contact info, employers,
schools, or URLs; only summary / skills / target roles. Raw CVs live in `data/cvs/` and are
**gitignored** (never committed).

Labels are agent-drafted; the labeling authority (the CV owner for the seed profiles, the repo
owner for the dataset-derived ones) refines `goodIds` in `data/profiles/<id>.json` and re-runs
`build:dataset`. `draft-labels` produces that draft — it judges each pooled candidate against the
profile ONE at a time (independently, so no candidate is judged in the company of its neighbours)
under `scripts/label-judge.ts`'s rubric, which is deliberately NOT the production rerank rubric:
that one orders a digest on a 0–1 scale, and reusing a ranker's own prompt to manufacture its
ground truth would make the eval partly self-graded. Verdicts are three-way — only `good` becomes a
label, and `borderline` keeps the judge's uncertainty visible instead of rounding it away. Each run
writes `data/reviews/<id>.md` (gitignored): every verdict with a one-sentence reason, borderlines
called out first, since that is where owner review changes the ground truth most. Re-running will
not overwrite existing labels without `--force`.

Scale the set toward the spec's ~50 examples via public CV datasets (Kaggle/HuggingFace) + more ATS
boards as adapters land.

## Test profiles

The profiles the eval runs on are what the production CV extraction (transcribe → structure → scrub,
the calls `ingestCv` makes) produced from a fixed set of 64 CVs. They are spread over four field
groups, so a result can be read per group instead of as one average that tech would dominate:

| group                                                                  | profiles | dataset CVs | synthetic CVs |
| ---------------------------------------------------------------------- | -------- | ----------- | ------------- |
| `healthcare-licensed`: healthcare, and other work that needs a licence | 19       | 15          | 4             |
| `hourly-shift`                                                         | 18       | 14          | 4             |
| `other-non-tech`                                                       | 19       | 15          | 4             |
| `tech`, kept as a regression check                                     | 8        | 8           | 0             |

`pnpm --filter @opusfinder/eval run cv-extract list` prints the current counts.

- `data/cv-extract/cvs.json` is the registry: every CV's id, its group and where the file comes from.
  - **Dataset CVs** are PDFs from the CC0 Kaggle "Resume Dataset" (through the `opensporks/resumes`
    mirror on Hugging Face), each pinned to the dataset commit, the path and the PDF's SHA-256. They
    are not committed, because the dataset's anonymisation leaves a few names and dates behind.
    `cv-extract fetch` downloads them to the gitignored `data/cvs/cv-extract/` and fails on any file
    whose checksum differs, so every checkout works from the same bytes. Transcripts are cached there
    too and are not committed either.
  - **Synthetic CVs** (`data/cv-extract/synthetic/<id>.html` and the `<id>.pdf` rendered from it) cover
    what the dataset lacks: it is all single-column, so these are set in sidebar and two-column
    layouts, and they add occupations it has few of. Each describes nobody (the name, contact
    details, employers and numbers are invented) and was written from a real job posting, recorded in
    the registry as `source.posting`. A harness should check whether that posting is in its job pool:
    it is a near-certain match for that profile.
- `data/cv-extract/v<N>/<id>.json` is the profile extraction version N produced from each CV.
  `cv-extract run` fills the current version's directory.

`loadProfileSet()` (`src/profile-set.ts`) returns the set: for each CV its `id`, `group`, `source`,
the `StructuredProfile`, and a `contentHash` (SHA-256 over the whole stored profile, key order and
formatting aside). Ids are stable across re-extractions; the hash changes whenever the profile does, so
a label keyed on `(id, contentHash)` can tell that it was made against an older profile. The set is
read at `PROFILE_SET_VERSION`, which is deliberately not `CV_EXTRACT_VERSION`: a prompt change in
production does not re-key the eval until that constant is moved.

**Real people's CVs** (the owner's, and testers who agreed) are never committed in any form. They go to
the eval bucket under `profiles/` (`src/private-profiles.ts`: `profiles/index.json`, and per person
`profiles/<id>/cv.pdf`, `transcript.txt` and `v<N>.json`), under an opaque id. `addPrivateProfile`
uploads one, `loadPrivateProfiles` returns them in the same shape as `loadProfileSet`,
`restructurePrivateProfiles` re-extracts them from the stored transcripts when the version moves, and
`removePrivateProfile` deletes everything held about one person.

**To add a synthetic CV:** write `<id>.html` against one of `synthetic/layouts/*.css`, render it with
any Chromium (`chromium --headless --no-pdf-header-footer --print-to-pdf=<id>.pdf <id>.html`), add it
to `cvs.json` with the PDF's SHA-256 and the posting it was written from, then `cv-extract run`. To add
a dataset CV, add its pin to `cvs.json` and run `cv-extract fetch`, then `run`.

The 12 pooled profiles in `data/profiles/` (see "Profiles, labels, and PII") are the old prompt's
output for 12 of these CVs and are kept only for the pooled-label flow above. The set holds the same
CVs re-extracted, under the same ids except two that were taken: `finance-manager` there is
`cost-accounting-manager` here, and `hr-manager` is `hr-director-manufacturing`.

## CV extraction check

`cv-extract score` checks the extraction against a hand-written key, field by field, for the 39 CVs
that have one. Run it before changing the CV prompts or schema, and bump `CV_EXTRACT_VERSION`
(`@opusfinder/llm`) with the change. It is not a CI gate: the model is live.

- `data/cv-extract/keys/<id>.json` — one key per keyed CV: what a correct extraction holds, and the
  entries where another reading is defensible (`judgementCalls`). The CV's group and source are in the
  registry. The format and its matching rules are documented in `src/cv-extract-key.ts`.
  - **27 keys are the ones the version-2 prompt was tuned against** (one round, on these same CVs).
  - **12 are held out** (`"heldOut": true`): six dataset CVs and six synthetic ones, two of each in
    every non-tech group. Their keys were drafted before the prompt was run on them, the dataset ones
    by a drafter that had not read the prompt. Never tune a prompt against them; their score is the
    one that says how the prompt does on CVs it was not fitted to.
- `data/cv-extract/v<N>/<id>.json` — the profile extraction version N produced for each CV. `v1` is
  the baseline: the structuring prompt as it was before `facts` existed, run once over the first 27
  CVs' transcripts. It cannot be regenerated from the current code and does not need to be.
- `data/cv-extract/v<N>-run2/<id>.json` — a second run of version N over the held-out CVs, from
  scratch (its own transcripts), kept so the report can say what changes between two runs.
- `reports/cv-extract.json` — every kept version scored against the key: overall, tuned-on against
  held-out, per group, per field, each wrong field with the reason, and the two-run comparison.

```
pnpm --filter @opusfinder/eval run cv-extract fetch     # download the dataset CVs (public, no key), verify all checksums
pnpm --filter @opusfinder/eval run cv-extract run       # extract with the current prompt (OpenRouter)
pnpm --filter @opusfinder/eval run cv-extract run --repeat   # the held-out CVs a second time → v<N>-run2/
pnpm --filter @opusfinder/eval run cv-extract score     # score every version, write the report
pnpm --filter @opusfinder/eval run cv-extract review    # the key as a review sheet (data/reviews/)
pnpm --filter @opusfinder/eval run cv-extract list      # the profile set's counts
```

**Version 2 as committed:** 96.9% of fields right on the 27 tuned-on CVs (216/223), and on the 12
held-out CVs 96.0% in the first run (97/101) and 98.0% in the second (99/101). Four of the 101
held-out fields were right in one run and wrong in the other, so a single run's figure moves by a few
points. Both runs missed a "U.S. citizen" note that sat in a two-column CV's contact line: the
transcription drops contact lines, and the statement went with it.

**The keys are drafted and not yet owner-checked**, so the committed report's numbers are provisional.
Each key's `judgementCalls` lists where another reading of the CV is defensible; check those, and the
rules behind them (a licence used as a job title counts, trainings are not credentials, years are
stated-only, no status is inferred), before relying on the numbers or seeding anything from `facts`.

A field is right only when everything the key requires is there and nothing it does not allow is, so
one extra or missing licence fails the whole `credentials` field for that CV. A version-1 profile has
no `facts` and is scored as stating none.

## Status (Phase 5)

- Harness, metrics, random baseline, embedding ranker, `pnpm eval` + reports: **done**.
- Voyage `voyage-3-large` retrieval validated on the real seed set (NDCG@10 ≈ 83% vs random ≈ 9%);
  the committed Voyage report is still that run.
- **Voyage-vs-OpenAI comparison: done → Voyage wins** (NDCG@10 83.2% vs OpenAI
  `text-embedding-3-small` 66.9% on the seed set), so Voyage is the chosen provider. The harness
  is provider-agnostic — `pnpm eval:compare` reproduces the head-to-head, and `--embedder` swaps
  providers in one argument. Verdict + caveats in `research/specs/OPEN_DECISIONS.md`; re-decide
  when the labeled set scales (~50 examples).

## LLM rerank (Phase 10)

The `llm-rerank` ranker (`src/rankers/llm-rerank.ts`) runs the **shared** `rerankCandidates` from
`@opusfinder/rerank` (the core the digest pipeline runs) through a deterministic stub call seeded per
profile, and writes `reports/llm-rerank-stub.dataset.json`. The stub proves the core (chunking,
merging, backfill) and the wiring only; its scores are random-equivalent, not rerank quality. The real
Haiku call has never been scored here.

## Calling any model

`callModel` (`src/model-caller.ts`) sends one structured-output request to any OpenRouter model, for
head-to-heads between models `@opusfinder/llm` doesn't call. The route names the model, the hosts it may
run on and, optionally, the quantisation:

```ts
const { object, usage, host, servedModel } = await callModel({
  route: {
    model: "deepseek/deepseek-v4.1-flash",
    hosts: ["deepinfra/fp8"],
    quantizations: ["fp8"],
  },
  schema: MyZodSchema,
  system,
  messages: [{ role: "user", content }],
  reasoningEffort: "low",
});
```

- The request runs only on the named hosts, only on a host that honours every parameter sent, and never
  on one that trains on its inputs. None of the three can be switched off.
- The reply says which host served it; one from any other host throws.
- A reply that can't be used (truncated, refused, off-schema, wrong host) throws `ModelReplyError` with
  the reason and what the reply cost, and is not re-sent. Network failures, timeouts, 429s and 5xx are
  retried; what's left throws `OpenRouterError`.
- State the output contract (scales, allowed values, length limits) in the prompt, not only in the
  schema's `.describe()` text. Hosts differ: DeepInfra decodes against the schema but shows the model
  none of its text, while Anthropic reads the descriptions but doesn't enforce number or length bounds
  (`src/strict-schema.ts`). `servedModel` is the dated build, so a report can say exactly what ran.
- `modelRerankCall(route)` (`src/rankers/model-rerank.ts`) is the digest's rerank request on this caller:
  pass it to `llmRerankRanker(call)`. The ranker's default is still the stub.

`rerank:parity` checks the caller against production: it reranks the 2 legacy examples several times
through `@opusfinder/llm` and through this caller with the same model, and passes when the paths differ by
no more than one path differs from itself run to run (`src/score-parity.ts`). The live suite
(`MODEL_CALLER_LIVE_TEST=1 pnpm test:live`) makes one real call to a non-Anthropic model on a pinned host.

## Keys

- `OPENAI_API_KEY` → `packages/eval/.env` (this package; for the comparison).
- `VOYAGE_API_KEY` / `DATABASE_URL` are read from the embeddings/db packages (Phase 4/0).
- `OPENROUTER_API_KEY` → `packages/llm/.env` (for `draft-labels` and `extract-profile`).
