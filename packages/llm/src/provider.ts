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

// All provider-specific wiring lives in this file (createAnthropic, getProvider, MODEL_IDS) plus the
// key guard in env.ts; generate.ts/batch.ts stay provider-agnostic via resolveModel().
let provider: ReturnType<typeof createAnthropic> | undefined;

function getProvider(): ReturnType<typeof createAnthropic> {
  // Lazy + memoized: importing @opusfinder/llm must not require a key; the key is read only on the
  // first real model resolution and captured for the process lifetime, so a rotated ANTHROPIC_API_KEY
  // needs a restart.
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
