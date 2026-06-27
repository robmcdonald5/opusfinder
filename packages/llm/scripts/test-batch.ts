/**
 * batchGenerate smoke: submit a real 2-request Message Batch (Haiku 4.5, 50% discount), poll
 * to completion, and confirm results map back by custom_id with the cache counters observable. The
 * shared system prompt is padded past Haiku's ~4096-token cache minimum so caching CAN engage — but
 * intra-batch hits are best-effort (concurrent processing), so the counters are LOGGED, not asserted.
 * Needs ANTHROPIC_API_KEY (packages/llm/.env). A tiny batch usually settles in well under a minute.
 */
import { batchGenerate } from "../src/index.ts";
import { runScript } from "@opusfinder/shared/script";

async function main(): Promise<void> {
  // ~5–6K tokens of stable prefix (above Haiku's 4096-token cache minimum).
  const system = "You are a concise assistant. Answer in a single short sentence. ".repeat(400);

  const results = await batchGenerate(
    [
      {
        customId: "smoke-1",
        model: "haiku",
        system,
        cacheSystem: true,
        maxOutputTokens: 64,
        messages: [{ role: "user", content: "What is the capital of France?" }],
      },
      {
        customId: "smoke-2",
        model: "haiku",
        system,
        cacheSystem: true,
        maxOutputTokens: 64,
        messages: [{ role: "user", content: "What is the capital of Japan?" }],
      },
    ],
    {
      pollIntervalMs: 5_000,
      maxWaitMs: 15 * 60 * 1000,
      onPoll: (progress) =>
        console.log(`poll: status=${progress.status} processing=${progress.counts.processing} succeeded=${progress.counts.succeeded}`),
    },
  );

  const byId = new Map(results.map((result) => [result.customId, result]));
  for (const id of ["smoke-1", "smoke-2"]) {
    const result = byId.get(id);
    console.log(
      `${id}: status=${result?.status} text="${(result?.text ?? "").slice(0, 60)}" ` +
        `cacheRead=${result?.usage?.cacheReadInputTokens ?? "-"} cacheCreate=${result?.usage?.cacheCreationInputTokens ?? "-"} ` +
        `in=${result?.usage?.inputTokens ?? "-"}`,
    );
  }

  const ok =
    results.length === 2 &&
    byId.has("smoke-1") &&
    byId.has("smoke-2") &&
    results.every((r) => r.status === "succeeded" && r.text.trim().length > 0);
  console.log(`\nSMOKE ${ok ? "PASS" : "CHECK"}`);
  if (!ok) process.exitCode = 1;
}

await runScript("test-batch", main);
