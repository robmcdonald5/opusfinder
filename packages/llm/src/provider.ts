import { createAnthropic } from "@ai-sdk/anthropic";

import { getAnthropicApiKey } from "./env";

/**
 * The model tiers the rest of the system selects between, so callers never hardcode
 * raw model IDs. Haiku = cheap/fast (filter, rerank, CV extraction); Sonnet =
 * stronger (digest synthesis).
 */
export type ModelAlias = "haiku" | "sonnet";

// Model aliases (not dated snapshots): each floats to the latest snapshot of its model
// version line — e.g. claude-haiku-4-5 resolves to the newest Haiku 4.5 build — so we
// pick up re-releases without a code change. This tracks the version LINE only: it won't
// jump to a future Haiku 4.6 / Sonnet 4.7 on its own (bump the string here for that).
// The Vercel AI SDK types model IDs as `(string & {})`, so these pass through without a
// type error and are sent verbatim to the API.
const MODEL_IDS: Record<ModelAlias, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
};

// --- Provider swap point -----------------------------------------------------------
// All provider-specific wiring lives in this file: the `createAnthropic` import, the
// `getProvider()` construction, and the `MODEL_IDS` map. Swapping to OpenAI (the Phase
// 3 abstraction sanity check) means changing those spots here PLUS the key guard in
// env.ts (getAnthropicApiKey -> an OpenAI key) — but nothing in generate.ts/batch.ts,
// which stay provider-agnostic and only see the model object from resolveModel(). e.g.:
//
//   import { createOpenAI } from "@ai-sdk/openai";
//   provider ??= createOpenAI({ apiKey: getOpenAiApiKey() });
//   const MODEL_IDS = { haiku: "gpt-...", sonnet: "gpt-..." };
let provider: ReturnType<typeof createAnthropic> | undefined;

function getProvider(): ReturnType<typeof createAnthropic> {
  // Lazy + memoized: importing @opusfinder/llm must not require a key (type-only
  // consumers, the batch stub). The key is read only on the first real model
  // resolution. Note: the instance (and the key it captured) lives for the process
  // lifetime — fine for short-lived scripts and Phase 8 cron Workers, but a long-lived
  // process won't pick up a rotated ANTHROPIC_API_KEY without a restart.
  provider ??= createAnthropic({ apiKey: getAnthropicApiKey() });
  return provider;
}

/** Resolve a tier alias to a configured Vercel AI SDK language model. */
export function resolveModel(alias: ModelAlias) {
  return getProvider()(MODEL_IDS[alias]);
}

/** The raw Anthropic model-id string for a tier alias. The Vercel AI SDK path uses {@link
 *  resolveModel}; the Message Batches path (batch.ts) talks to the raw `@anthropic-ai/sdk` and needs
 *  the bare id. Single source of truth so the two paths can't disagree on which model a tier maps to. */
export function modelId(alias: ModelAlias): string {
  return MODEL_IDS[alias];
}
