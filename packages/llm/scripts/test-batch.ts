/**
 * batchGenerate smoke: submit a real 3-request batch (Haiku, OpenRouter Batch API), poll to completion,
 * and confirm results map back by custom_id — one plain-text, one thinking-off, one schema-constrained
 * (parsed with parseObject) — with the cache counters and the batch cost observable. The shared system
 * prompt clears Haiku's 512-token cache minimum so caching CAN engage, but intra-batch hits are
 * best-effort (concurrent processing), so the counters are LOGGED, not asserted. Needs OPENROUTER_API_KEY
 * (packages/llm/.env). A tiny batch has taken 10–15 minutes.
 */
import { z } from "zod";

import { runScript } from "@opusfinder/shared/script";

import { batchGenerate, parseObject } from "../src/index.ts";

async function main(): Promise<void> {
  const system = "You are a concise assistant. Answer in a single short sentence. ".repeat(100);
  const CitySchema = z.object({ city: z.string() });

  const { results, costUsd } = await batchGenerate(
    [
      {
        customId: "smoke-1",
        model: "haiku",
        system,
        cacheSystem: true,
        effort: "low",
        maxOutputTokens: 256,
        messages: [{ role: "user", content: "What is the capital of France?" }],
      },
      {
        customId: "smoke-2",
        model: "haiku",
        system,
        cacheSystem: true,
        effort: "low",
        thinking: "off",
        maxOutputTokens: 256,
        messages: [{ role: "user", content: "What is the capital of Japan?" }],
      },
      {
        customId: "smoke-3",
        model: "haiku",
        system,
        cacheSystem: true,
        effort: "low",
        schema: CitySchema,
        maxOutputTokens: 256,
        messages: [{ role: "user", content: "Name the capital of Italy." }],
      },
    ],
    {
      pollIntervalMs: 10_000,
      maxWaitMs: 30 * 60 * 1000,
      onPoll: (p) =>
        console.log(
          `poll: ${p.state} ${p.counts.completed}/${p.counts.total} (failed ${p.counts.failed})`,
        ),
    },
  );

  const byId = new Map(results.map((result) => [result.customId, result]));
  for (const id of ["smoke-1", "smoke-2", "smoke-3"]) {
    const r = byId.get(id);
    console.log(
      `${id}: status=${r?.status} stop=${r?.stopReason} text="${(r?.text ?? "").slice(0, 60)}" ` +
        `cacheRead=${r?.usage?.cacheReadInputTokens ?? "-"} cacheCreate=${r?.usage?.cacheCreationInputTokens ?? "-"} ` +
        `in=${r?.usage?.inputTokens ?? "-"} out=${r?.usage?.outputTokens ?? "-"}`,
    );
  }
  console.log(`batch cost (USD): ${costUsd}`);

  const city = parseObject(CitySchema, byId.get("smoke-3")?.text ?? "");
  const ok =
    results.length === 3 &&
    results.every(
      (r) => r.status === "succeeded" && r.stopReason === "end_turn" && r.text.trim().length > 0,
    ) &&
    city.city.length > 0;
  console.log(`\nSMOKE ${ok ? "PASS" : "CHECK"}`);
  if (!ok) process.exitCode = 1;
}

await runScript("test-batch", main);
