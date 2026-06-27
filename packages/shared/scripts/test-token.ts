// Smoke check for generateUnsubscribeToken: locks that the token is URL-safe, unguessable (random,
// NOT email-derived), and collision-free so a regression fails loudly.
// Run: pnpm --filter @opusfinder/shared test:token
import { generateUnsubscribeToken } from "../src/index";
import { runScript } from "../src/script";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const token = generateUnsubscribeToken();

  // 1. URL-safe charset (lowercase hex) — no escaping needed in a List-Unsubscribe URL.
  check("URL-safe hex charset", /^[0-9a-f]+$/.test(token), JSON.stringify(token));

  // 2. 32 bytes → 64 hex chars (256 bits of entropy).
  check("64-char (256-bit) length", token.length === 64, `len ${token.length}`);

  check("distinct across calls", generateUnsubscribeToken() !== generateUnsubscribeToken());

  // 4. No collisions across a large batch — sanity on the RNG (a broken/constant source fails here).
  const N = 10000;
  const seen = new Set<string>();
  for (let i = 0; i < N; i++) seen.add(generateUnsubscribeToken());
  check(`no collisions in ${N}`, seen.size === N, `unique ${seen.size}/${N}`);

  if (failures === 0) {
    console.log("\nPASS: unsubscribe-token contract holds.");
    return;
  }
  console.error(`\nFAIL: ${failures} check(s) failed.`);
  process.exitCode = 1;
}

await runScript("test-token", main);
