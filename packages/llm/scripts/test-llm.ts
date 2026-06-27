import { randomUUID } from "node:crypto";

import { runScript } from "@opusfinder/shared/script";

import { generate } from "../src/index";
import type { GenerateResult } from "../src/index";

// Anthropic only caches a prompt prefix once it clears a per-model minimum (a few
// thousand input tokens, model-dependent; highest for the Haiku 4.x tier). Below that
// the cacheControl marker is silently ignored and there is no cache hit to observe. So
// the system prompt below is deliberately large.
function buildSystemPrompt(): string {
  const intro = [
    // Per-run nonce: makes the cached system prompt unique each run, so the cache is
    // cold at call 1 (creation) and warm at call 2 (read) regardless of the 5-minute
    // ephemeral TTL left over from any previous run.
    `Session ${randomUUID()}.`,
    "You are opusfinder's job-matching assistant.",
    "Given a candidate profile and a batch of job postings, you rerank the postings",
    "by genuine fit and explain each decision. Follow the rubric below exactly.",
  ].join(" ");

  const rubric: string[] = [];
  for (let i = 1; i <= 120; i++) {
    rubric.push(
      `Rule ${i}: Weigh role seniority, core skills overlap, domain relevance, ` +
        `location and remote compatibility, compensation signals, and recency. ` +
        `Penalize postings that contradict a hard constraint; reward specific, ` +
        `verifiable skill matches over generic keyword overlap. Never invent details ` +
        `that are not present in the posting or the profile.`,
    );
  }

  return [intro, ...rubric].join("\n");
}

const SYSTEM_PROMPT = buildSystemPrompt();

async function runOnce(label: string): Promise<GenerateResult> {
  const result = await generate({
    model: "haiku",
    system: SYSTEM_PROMPT,
    cacheSystem: true,
    maxOutputTokens: 64,
    messages: [
      {
        role: "user",
        content: "In one short sentence, confirm you are ready to rerank job postings.",
      },
    ],
  });

  const preview = result.text.replace(/\s+/g, " ").trim().slice(0, 120);
  console.log(`\n[${label}]`);
  console.log(`  completion:            ${preview}`);
  console.log(`  finish reason:         ${result.finishReason}`);
  console.log(`  input tokens:          ${result.usage.inputTokens ?? "?"}`);
  console.log(`  output tokens:         ${result.usage.outputTokens ?? "?"}`);
  console.log(`  cache_creation_tokens: ${result.cache.creationInputTokens}`);
  console.log(`  cache_read_tokens:     ${result.cache.readInputTokens}`);
  return result;
}

async function main(): Promise<void> {
  console.log(
    `System prompt size: ${SYSTEM_PROMPT.length} chars ` +
      `(~${Math.round(SYSTEM_PROMPT.length / 4)} tokens). ` +
      "Calling Haiku twice with a cached system prompt...",
  );

  // Sequential so the cache exists before call two, and well within the 5-minute ephemeral TTL.
  const first = await runOnce("call 1 - expect cache creation");
  const second = await runOnce("call 2 - expect cache read");

  // Assert, don't just print: a green run must actually prove caching engaged. If both
  // counters are 0 the system prompt was likely below the model's minimum cacheable size.
  if (first.cache.creationInputTokens > 0 && second.cache.readInputTokens > 0) {
    console.log("\nPASS: prompt caching verified (call 1 created the cache, call 2 read it).");
    return;
  }

  console.error(
    "\nFAIL: expected call 1 to CREATE the cache (creation > 0) and call 2 to READ it " +
      `(read > 0), but got creation=${first.cache.creationInputTokens}, ` +
      `read=${second.cache.readInputTokens}. If both are 0, the system prompt may be below ` +
      "the model's minimum cacheable size.",
  );
  process.exitCode = 1;
}

await runScript("test-llm", main);
