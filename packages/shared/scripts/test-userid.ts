// Golden-vector contract check for the must-never-change identity + profile-text logic.
// Run: pnpm --filter @opusfinder/shared test:userid
//
// mintUserId is load-bearing: a different output for the same email would re-mint user ids and
// orphan existing user_profiles rows (see src/userid.ts). composeProfileText feeds the embedding
// vector for BOTH the eval harness and production ingest, so a silent format change shifts every
// profile's retrieval. These frozen vectors lock both contracts so a regression fails loudly
// instead of corrupting identities/metrics. If a DELIBERATE change moves them, update with intent.
import { composeProfileText, scrubProfilePii } from "../src/index";
import { runScript } from "../src/script";
import { mintUserId } from "../src/userid";

// FROZEN. mintUserId("test@example.com") under the fixed OPUSFINDER_USER_NS namespace.
const GOLDEN_USER_ID = "e101ed0f-2164-5103-a339-e2df142331eb";
const GOLDEN_PROFILE_TEXT = "Senior backend engineer.\n\nSkills: Go, Postgres\n\nTarget roles: Staff Engineer";

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
  // 1. Frozen golden vector — locks the algorithm, the namespace constant, AND normalization
  //    together. Any drift in the bit math or the namespace moves this.
  const id = mintUserId("test@example.com");
  check("frozen golden vector", id === GOLDEN_USER_ID, `got ${id}, want ${GOLDEN_USER_ID}`);

  // 2. Idempotent across surrounding whitespace + case.
  check("idempotent across case/whitespace", mintUserId("  TEST@Example.com ") === GOLDEN_USER_ID);

  // 3. Unicode NFC: precomposed vs decomposed forms of the same email mint the SAME id. Built at
  //    runtime (not as source literals) so the intended code points are unambiguous.
  const precomposed = "jos" + String.fromCodePoint(0x00e9) + "@example.com"; // josé (U+00E9)
  const decomposed = "jose" + String.fromCodePoint(0x0301) + "@example.com"; // jose + combining acute
  check("NFC-equivalent emails mint same id", mintUserId(precomposed) === mintUserId(decomposed));

  // 4. Different email → different id.
  check("distinct emails differ", mintUserId("other@example.com") !== GOLDEN_USER_ID);

  // 5. Shape: a valid UUIDv5 (version nibble 5, RFC 4122 variant 8|9|a|b).
  check("version nibble is 5", id[14] === "5", `version char = ${String(id[14])}`);
  check("variant nibble is 8|9|a|b", ["8", "9", "a", "b"].includes(id[19] ?? ""), `variant char = ${String(id[19])}`);

  // 6. Empty / whitespace-only email is rejected loudly.
  let threw = false;
  try {
    mintUserId("   ");
  } catch {
    threw = true;
  }
  check("empty email throws", threw);

  // 7. composeProfileText output is pinned (label format + ordering + blank-dropping).
  const text = composeProfileText({
    summary: "Senior backend engineer.",
    skills: ["Go", "Postgres"],
    targetRoles: ["Staff Engineer"],
  });
  check("composeProfileText golden", text === GOLDEN_PROFILE_TEXT, JSON.stringify(text));
  check(
    "composeProfileText all-blank → empty",
    composeProfileText({ summary: "", skills: [], targetRoles: [] }) === "",
  );

  // 8. scrubProfilePii redacts machine-detectable PII (email + >=10-digit phone), keeps the rest.
  const scrubbed = scrubProfilePii({
    summary: "Senior engineer; reach me at jane.doe@example.com or (682) 333-9323. Worked 2015-2019.",
    skills: ["Go", "PostgreSQL"],
    targetRoles: ["Staff Engineer"],
  });
  check("scrub redacts email", !/@example\.com/.test(scrubbed.summary), scrubbed.summary);
  check("scrub redacts phone", !/333-9323/.test(scrubbed.summary));
  check("scrub preserves a year range", /2015-2019/.test(scrubbed.summary));
  check("scrub preserves non-PII fields", scrubbed.skills.length === 2 && scrubbed.targetRoles.length === 1);

  if (failures === 0) {
    console.log("\nPASS: userid + profile-text contracts hold.");
    return;
  }
  console.error(`\nFAIL: ${failures} contract check(s) failed.`);
  process.exitCode = 1;
}

await runScript("test-userid", main);
