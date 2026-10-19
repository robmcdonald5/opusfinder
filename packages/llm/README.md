# @opusfinder/llm

Every model call in opusfinder: Claude Haiku 5.5 and Sonnet 5.5 through **OpenRouter**, one
`OPENROUTER_API_KEY`. Calls use OpenRouter's Anthropic-compatible Messages API (`/api/v1/messages`)
and its Batch API (`/api/v1/batches`), so **prompt caching**, **structured output**
(`output_config.format`) and the per-call **effort / thinking** controls are Anthropic's own request
fields, built in one place (`src/messages.ts`) for both the sync calls and the batch. Downstream:
CV extraction, digest rerank + synthesis, the eval label judge.

## Setup

This package needs an OpenRouter API key. Either:

- put it in `packages/llm/.env` (gitignored):

  ```
  OPENROUTER_API_KEY=sk-or-...
  ```

- or export `OPENROUTER_API_KEY` in your shell (a pre-set env var wins over the file).

The key is read + validated by `getOpenRouterApiKey()` (`@opusfinder/llm/env`) on each request. It
loads `packages/llm/.env` resolved relative to the module (never the caller's cwd), so the key lives
in ONE place no matter which package's script imports it. Errors echo only the key's shape
(presence/length), never the key itself.

## API

Every call takes the same options (`CallOptions`): `model` (`"haiku"` | `"sonnet"`, tier aliases mapped
to OpenRouter slugs in `src/provider.ts`), `messages`, `system`, `cacheSystem`, `maxOutputTokens`,
`effort` and `thinking`.

```ts
import { generate, generateObject } from "@opusfinder/llm";

const result = await generate({
  model: "haiku",
  system: "You are a job-matching assistant...",
  cacheSystem: true, // mark the system prompt as a cache breakpoint
  effort: "low", // "low" | "medium" | "high" | "xhigh" | "max"; omitted = the model's default
  thinking: "off", // "adaptive" (default) | "off" — off needs effort "high" or below
  messages: [{ role: "user", content: "Rerank these postings..." }],
  maxOutputTokens: 1024, // optional, defaults to 1024; thinking counts toward it
});

result.text; // completion (thinking blocks excluded)
result.stopReason; // "end_turn" | "max_tokens" (TRUNCATED) | "refusal" | ...
result.usage; // { inputTokens, outputTokens, costUsd } — costUsd is what OpenRouter charged
result.cache; // { creationInputTokens, readInputTokens }

const { object } = await generateObject({ model: "haiku", schema: MyZodSchema, messages, effort: "low" });
```

`generateObject` sends the zod schema as `output_config.format` (constrained decoding, via the Anthropic
SDK's `zodOutputFormat`, which moves constraints the API can't enforce, like number bounds, into field
descriptions), validates the reply with the same schema, and retries an off-schema reply once. A
truncated or refused reply, or a second off-schema one, throws `ObjectGenerationError`; provider errors
throw `OpenRouterError` (status + type, never a body) after the transport's retries on 408/429/5xx.

Neither model takes `temperature`/`top_p`/`top_k`, so there is no sampling option: steer with effort and
the prompt. Every sync call sends `provider: { require_parameters: true, data_collection: "deny" }`, so
OpenRouter routes only to a provider that honors every field sent and doesn't store or train on the text.

### Prompt caching

`cacheSystem: true` sends the system prompt as a text block with `cache_control`. The first call with a
given system prompt **writes** the cache (`cache.creationInputTokens > 0`); later calls within the
5-minute TTL **read** it (`cache.readInputTokens > 0`). A cached call also carries a `session_id` derived
from the model and system prompt, which keeps every call sharing that prefix on one OpenRouter provider
(caches are per provider). Both tiers cache a prefix from 512 tokens; below that the marker is silently
ignored, so verify via the returned counters.

### Batch generation

`submitBatch()` / `pollBatch()` / `collectBatchResults()` (and the `batchGenerate()` convenience wrapper)
drive OpenRouter's **Batch API** (about half the per-token price). Each request is the same Messages body
a sync call sends; a cached system prompt gets a 1-hour TTL. A request may carry a `schema`; parse its
result's `text` with `parseObject(schema, text)`. One batch runs one model tier. The Batch API rejects
some sync-only settings by failing the whole batch after accepting it, so `submitBatch` refuses them up
front: Sonnet's thinking-off and inline PDF parts. Results come back inline once the batch completes;
`collectBatchResults` returns them by `customId` plus the batch's total `costUsd` (OpenRouter reports cost
per batch, not per request), and throws when the batch failed, expired or was cancelled as a whole. There
is no cancel endpoint. The digest pipeline (`@opusfinder/inngest`) submits a batch, suspends on Inngest's
durable sleep across the wait, then collects.

### Digest prompts

`prompts/digest.ts` (`DIGEST_SYNTHESIS_SYSTEM` / `buildDigestSystem` / `renderDigestJob`) is the Sonnet
"why matched" synthesis; `buildDigestSystem(profile, prefs?: PromptPreferences)` appends the shared
`composePromptPrefs` block, and `DIGEST_SYNTHESIS_SYSTEM` grounds level-fit in the declared YoE band,
never frames the note around a dealbreaker, and keeps salary/location off-limits; `prompts/rerank.ts`
(`RerankScoresSchema` / `renderRerankCandidates`) is the Haiku rerank output schema + candidate
renderer. The rerank **scoring rubric** and orchestration live in `@opusfinder/rerank` (shared with the
eval harness), not here — this package owns only the per-call prompt pieces.

## Test

```bash
pnpm llm:test   # from repo root, or: pnpm --filter @opusfinder/llm test:llm
```

`scripts/test-llm.ts` calls Haiku twice with a cached system prompt, prints the completion, cost and
cache counters for each call, and **asserts** that call 1 created the cache and call 2 read it.
`test:generate-object` checks extraction, caching and the truncation error; `test:batch` runs a real
3-request batch (plain, thinking-off, schema-constrained) end to end — a small batch has taken 10–15
minutes. All three spend a few cents of OpenRouter credit.
