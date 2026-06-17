// Smoke check for parseEnforceFlag (Phase F2 review, Group A) — the SINGLE switch that flips all three
// F2 lifecycle-close arms (sweepLifecycle / closeJobsForCompanies / probeDigestLiveness) from shadow to
// enforce. The whole point of the switch is that exactly ONE value enables the 'closed' write, so these
// checks lock which strings are affirmative and (critically) that the safe/default values stay shadow.
// A regression that made "shadow"/""/undefined enforce would silently start closing jobs in production.
// Run: pnpm --filter @opusfinder/shared test:enforce-flag
import { parseEnforceFlag } from "../src/index";
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
  // Affirmatives → enforce (true), case/space-insensitive.
  for (const v of ["enforce", "ENFORCE", "  Enforce ", "true", "1", "on", "yes", "YES"]) {
    check(`"${v}" → enforce`, parseEnforceFlag(v) === true, `got ${parseEnforceFlag(v)}`);
  }
  // Everything else → shadow (false). The default-safety cases are the load-bearing ones.
  for (const v of ["shadow", "off", "", "  ", "false", "0", "no", "enforced", "enabletrue"]) {
    check(`"${v}" → shadow`, parseEnforceFlag(v) === false, `got ${parseEnforceFlag(v)}`);
  }
  check("undefined → shadow (the unset default)", parseEnforceFlag(undefined) === false);

  if (failures === 0) {
    console.log("\nPASS: parseEnforceFlag — only explicit affirmatives enforce; default/shadow stays off.");
    return;
  }
  console.error(`\nFAIL: ${failures} check(s) failed.`);
  process.exitCode = 1;
}

await runScript("test-enforce-flag", main);
