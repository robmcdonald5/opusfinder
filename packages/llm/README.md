# @opusfinder/llm

Thin wrapper over the [Vercel AI SDK](https://ai-sdk.dev) with the Anthropic provider.
It makes Anthropic **prompt caching** first-class and sketches a **batch** helper.
Every downstream LLM step builds on it: CV extraction (Phase 9), digest rerank +
synthesis (Phase 10).

## Setup

This package needs an Anthropic API key. Either:

- put it in `packages/llm/.env` (gitignored):

  ```
  ANTHROPIC_API_KEY=sk-ant-...
  ```

- or export `ANTHROPIC_API_KEY` in your shell (a pre-set env var wins over the file).

The key is read + validated by `getAnthropicApiKey()` (`@opusfinder/llm/env`). It loads
`packages/llm/.env` resolved relative to the module (never the caller's cwd), so the key
lives in ONE place no matter which package's script imports it. Note: it is _this
package's own_ `.env` that is consulted — a caller's app-level `.env` is not read; put the
key in `packages/llm/.env` or a shell/process env var (which wins over the file). Errors
echo only the key's shape (presence/length), never the key itself.

## API

```ts
import { generate } from "@opusfinder/llm";

const result = await generate({
  model: "haiku", // "haiku" | "sonnet" — tier aliases, not raw model IDs
  system: "You are a job-matching assistant...",
  cacheSystem: true, // mark the system prompt as an ephemeral cache breakpoint
  messages: [{ role: "user", content: "Rerank these postings..." }],
  maxOutputTokens: 1024, // optional, defaults to 1024 — raise for long outputs
});

result.text; // completion
result.finishReason; // "stop" | "length" | ... — "length" means TRUNCATED at maxOutputTokens
result.usage; // { inputTokens, outputTokens, totalTokens }
result.cache; // { creationInputTokens, readInputTokens } — prompt-cache accounting
```

### Prompt caching

`cacheSystem: true` sends the system prompt as a cache-marked system message (a plain
`system` string cannot carry a cache breakpoint). The first call with a given system
prompt **writes** the cache (`cache.creationInputTokens > 0`); subsequent calls within
the ~5-minute TTL **read** it (`cache.readInputTokens > 0`).

> Anthropic only caches a prefix once it clears a per-model minimum (a few thousand
> input tokens; model-dependent and highest for the Haiku 4.x tier — confirm against
> current Anthropic docs). Below that the marker is silently ignored, so size cached
> prefixes generously and verify via the returned `cache` counters.

### Batch generation

`batchGenerate()` is a typed stub until **Phase 10**, where the digest pipeline wires
Anthropic's Message Batches API (50% token discount) via the raw `@anthropic-ai/sdk`.
The signature and the create → poll → results flow are documented in `src/batch.ts`.

### Swapping providers

All provider-specific wiring lives in `src/provider.ts` (provider construction + the
model-ID map) plus the key guard in `src/env.ts`. Swapping to OpenAI (e.g.
`@ai-sdk/openai`) is contained to those two spots — `generate()` / `batchGenerate()`
stay provider-agnostic. opusfinder ships only the Anthropic provider.

## Test

```powershell
pnpm llm:test   # from repo root, or: pnpm --filter @opusfinder/llm test:llm
```

`scripts/test-llm.ts` calls Haiku 4.5 twice with a cached system prompt, prints the
completion plus `cache_creation_tokens` / `cache_read_tokens` for each call, and
**asserts** the result — it exits non-zero unless call 1 created the cache and call 2
read it.
