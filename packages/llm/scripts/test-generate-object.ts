// Exercises generateObject end-to-end against Anthropic: (1) extraction of a valid CvProfileSchema
// profile from sample CV text, (2) prompt-cache plumbing (created on call 1, read on call 2), and
// (3) truncation surfaces as an actionable Error (not an opaque SDK throw). Requires
// ANTHROPIC_API_KEY in packages/llm/.env. (The PII scrub now lives in @opusfinder/shared — see test:userid.)
// Run: pnpm --filter @opusfinder/llm test:generate-object
import { randomUUID } from "node:crypto";

import { runScript } from "@opusfinder/shared/script";
import { z } from "zod";

import { generateObject } from "../src/generate-object";
import { CV_STRUCTURE_SYSTEM, CvProfileSchema } from "../src/prompts/cv-extract";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const SAMPLE_CV_TEXT = `SENIOR BACKEND ENGINEER

Experience
- Tech Lead, Payments Platform (2019-present): Led a team of 6 building a high-throughput payments
  service in Go and PostgreSQL on Kubernetes. Designed an idempotent ledger, cut p99 latency 40%,
  owned on-call and incident response.
- Backend Engineer (2015-2019): Built REST and gRPC services in Python and Go; set up CI/CD with
  GitHub Actions; migrated a monolith to event-driven microservices with Kafka.

Skills
Go, Python, PostgreSQL, Kafka, Kubernetes, gRPC, REST, distributed systems, observability,
Terraform, AWS.

Education
B.S. Computer Science.`;

function buildLargeSystemPrompt(): string {
  const intro = `Session ${randomUUID()}. You extract structured data from text.`;
  const rules: string[] = [];
  for (let i = 1; i <= 200; i++) {
    rules.push(
      `Rule ${i}: Ground every field in the provided text; never invent values; normalize and ` +
        `deduplicate; prefer canonical names; omit all personally-identifying information and ` +
        `formatting; resolve seniority from scope and trajectory rather than from title inflation.`,
    );
  }
  return [intro, ...rules].join("\n");
}

async function testExtraction(): Promise<void> {
  const r = await generateObject({
    model: "haiku",
    schema: CvProfileSchema,
    system: CV_STRUCTURE_SYSTEM,
    messages: [{ role: "user", content: SAMPLE_CV_TEXT }],
  });
  console.log("\n[extraction]");
  console.log(`  summary:     ${r.object.summary.slice(0, 100)}...`);
  console.log(`  skills:      ${r.object.skills.join(", ")}`);
  console.log(`  targetRoles: ${r.object.targetRoles.join(", ")}`);
  // Getting a result at all means the JSON parsed + validated (a truncated/invalid response would
  // have thrown — see testTruncation), so just assert the shape is non-empty.
  assert(r.object.summary.trim().length > 0, "summary is non-empty");
  assert(r.object.skills.length > 0, "skills is non-empty");
  assert(r.object.targetRoles.length > 0, "targetRoles is non-empty");
}

async function testCachePlumbing(): Promise<void> {
  const system = buildLargeSystemPrompt();
  const schema = z.object({ ready: z.boolean() });
  const messages = [{ role: "user" as const, content: 'Reply with {"ready": true}.' }];
  const first = await generateObject({ model: "haiku", schema, system, cacheSystem: true, messages, maxOutputTokens: 64 });
  const second = await generateObject({ model: "haiku", schema, system, cacheSystem: true, messages, maxOutputTokens: 64 });
  console.log("\n[cache plumbing]");
  console.log(`  system size:           ${system.length} chars (~${Math.round(system.length / 4)} tokens)`);
  console.log(`  call 1 cache_creation: ${first.cache.creationInputTokens}`);
  console.log(`  call 2 cache_read:     ${second.cache.readInputTokens}`);
  assert(
    first.cache.creationInputTokens > 0 && second.cache.readInputTokens > 0,
    "generateObject surfaces prompt-cache counters (call 1 created the cache, call 2 read it)",
  );
}

async function testTruncation(): Promise<void> {
  let threw: unknown;
  try {
    await generateObject({
      model: "haiku",
      schema: CvProfileSchema,
      system: CV_STRUCTURE_SYSTEM,
      messages: [{ role: "user", content: SAMPLE_CV_TEXT }],
      maxOutputTokens: 8, // far too small -> truncated JSON the SDK can't parse
    });
  } catch (e) {
    threw = e;
  }
  console.log("\n[truncation]");
  console.log(`  threw: ${threw instanceof Error ? `${threw.constructor.name}: ${threw.message}` : typeof threw}`);
  assert(
    threw instanceof Error && /^generateObject\(\):/.test(threw.message),
    "truncation throws our actionable generateObject() Error, not an opaque SDK error",
  );
  assert(
    /(maxOutputTokens|schema-valid)/.test((threw as Error).message),
    "the error message is actionable",
  );
}

async function main(): Promise<void> {
  await testExtraction();
  await testCachePlumbing();
  await testTruncation();
  console.log("\nPASS: extraction + caching + truncation-handling all verified.");
}

await runScript("test-generate-object", main);
