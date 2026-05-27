# @opusfinder/embeddings

A thin, **provider-agnostic** wrapper over [Voyage AI](https://voyageai.com) embeddings
(`voyage-3-large`, 1024 dims). The public surface is one function — `embed()` — that
turns texts into vectors and reports token usage. Job ingestion (Phase 4) writes
`jobs.embedding`; the user-profile embedding (Phase 9) and digest vector-retrieval
(Phase 10) reuse the same `embed()`.

It deliberately does **not** go through the Vercel AI SDK (which `@opusfinder/llm` uses):
embeddings get none of the SDK's value (no streaming, tools, or prompt caching), and a
direct REST call gives full control of `input_type` / `output_dimension` and surfaces
Voyage's token usage directly for cost logging.

## Setup

This package needs a Voyage API key. Either:

- put it in `packages/embeddings/.env` (gitignored):

  ```
  VOYAGE_API_KEY=pa-...
  ```

- or export `VOYAGE_API_KEY` in your shell (a pre-set env var wins over the file).

Get a key from the [Voyage AI dashboard](https://dashboard.voyageai.com); the free tier
(first 200M tokens) covers development comfortably. The key is read + validated by
`getVoyageApiKey()` (`@opusfinder/embeddings/env`), which loads `packages/embeddings/.env`
relative to the module (never the caller's cwd), so the key lives in ONE place no matter
which package's script imports it. Errors echo only the key's shape (presence/length),
never the key itself.

## API

```ts
import { embed, estimateCostUsd } from "@opusfinder/embeddings";

const { embeddings, usage, model } = await embed(["a job description", "another"], {
  inputType: "document", // "document" for the corpus (jobs), "query" for search text
});

embeddings; // number[][] — one 1024-dim vector per input, in input order
usage.totalTokens; // summed across any internal chunking
estimateCostUsd(usage.totalTokens); // USD at voyage-3-large list price
```

`embed()` transparently chunks large inputs to respect Voyage's per-request limits
(≤128 items + a ~90K-token budget — see `MAX_ITEMS_PER_REQUEST` / `MAX_TOKENS_PER_REQUEST` in `provider.ts`), preserving order and summing usage. Empty input is a
no-op (no network call).

### input_type asymmetry

Voyage prepends a model-specific prompt per `input_type`, and embedding the **corpus** as
`"document"` and the **search text** as `"query"` measurably improves retrieval. Jobs are
documents; the user profile is the query.

### Swapping providers

All Voyage specifics (endpoint, model id, dimensions, price, request/response mapping)
live in `src/provider.ts` plus the key guard in `src/env.ts`. Swapping to OpenAI
`text-embedding-3-small` (the Phase-5 eval comparison) is contained to those two files —
`embed()` stays provider-agnostic. Note: an OpenAI swap must request `dimensions: 1024`
to reuse the `jobs.embedding vector(1024)` column.

## Scripts

```powershell
# Backfill every job missing an embedding (idempotent — re-runs skip embedded rows):
pnpm embeddings:backfill            # or: pnpm --filter @opusfinder/embeddings backfill

# Embed a query string and print the nearest jobs (cosine over the HNSW index):
pnpm embeddings:search "senior backend engineer, Go, remote"
```

Both need `DATABASE_URL` (in `packages/db/.env`) and `VOYAGE_API_KEY` (here).
