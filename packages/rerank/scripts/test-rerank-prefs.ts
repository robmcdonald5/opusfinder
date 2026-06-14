import type { PromptPreferences, StructuredProfile } from "@opusfinder/shared";
import { runScript } from "@opusfinder/shared/script";

import { buildRerankSystem, rerankCandidates, type RerankCall, type RerankCandidate } from "../src/index";

/**
 * Stub smoke for the Phase-F3 prompt-prefs injection — NO creds, NO LLM. It locks the cache-safety and
 * wiring properties of the prefs block without a real model:
 *   - EMPTY/UNSET prefs produce a BYTE-IDENTICAL system to the no-prefs path (so an un-answered user's
 *     prompt-cache prefix does not bust on deploy — the single most load-bearing F3 cache claim);
 *   - non-empty prefs append a labeled "=== Candidate stated preferences ===" block with the YoE band /
 *     salary range / dealbreakers rendered (and only the set ones);
 *   - the system is built ONCE and passed IDENTICALLY to every chunk (so a caching call still hits the
 *     cache on chunks 2..N — the Phase-10 "cache read > 0" gate);
 *   - prefs are WIRED into the scoring path: with a stub that MODELS the rubric's declared-level rule, a
 *     low declared YoE band makes an over-leveled role rank BELOW a level-matched one. The stub is a
 *     test-only model of intent, NOT the LLM — it proves prefs reach the `system` the scorer reads and the
 *     intended DIRECTION; true semantic correctness is the live gate (PHASE_F3_PLAN.md §9, 3h).
 *
 *   pnpm --filter @opusfinder/rerank test:prefs
 */
const PROFILE: StructuredProfile = {
  summary: "Software engineer with a few internships; recent CS grad looking for a first full-time role.",
  skills: ["TypeScript", "Node.js", "PostgreSQL"],
  targetRoles: ["Software Engineer", "Backend Engineer"],
};

const EMPTY_PREFS: PromptPreferences = {
  yoeMin: null,
  yoeMax: null,
  minSalary: null,
  maxSalary: null,
  dealbreakers: [],
};

// A low target YoE band (0-2 yrs) — the declared-level signal (the too-senior fix). There is no categorical
// target_level; the band IS the level statement.
const JUNIOR_PREFS: PromptPreferences = {
  yoeMin: 0,
  yoeMax: 2,
  minSalary: 120000,
  maxSalary: null,
  dealbreakers: ["crypto"],
};

const CANDS: RerankCandidate[] = [
  { id: 1, title: "Staff Software Engineer", descriptionText: "Own org-wide technical strategy, 10+ yrs." },
  { id: 2, title: "Software Engineer I", descriptionText: "New-grad backend role, Node + Postgres, mentorship." },
  { id: 3, title: "Senior Platform Engineer", descriptionText: "Lead platform work, 6+ yrs." },
];

/** A test-only RerankCall that MODELS the rubric's declared-level rule: it reads the system for a low
 *  declared YoE band (the level signal) and, when present, down-scores obviously over-leveled titles.
 *  Records every `system` it is handed so the once-built-across-chunks property is assertable. */
function levelAwareStub(): { call: RerankCall; systems: string[] } {
  const systems: string[] = [];
  const call: RerankCall = async (system, cands) => {
    systems.push(system);
    const wantsLow = /Target years of experience: 0-2\b/.test(system);
    return cands.map((c) => {
      const overLeveled = /\b(staff|principal|director|senior)\b/i.test(c.title);
      return { id: c.id, score: wantsLow && overLeveled ? 0.1 : 0.8 };
    });
  };
  return { call, systems };
}

await runScript("test-rerank-prefs", async () => {
  // 1) Empty/unset prefs → BYTE-IDENTICAL system to the no-prefs path (no per-user cache bust).
  const noPrefs = buildRerankSystem(PROFILE);
  assert(noPrefs === buildRerankSystem(PROFILE, undefined), "undefined prefs must equal the no-arg system");
  assert(noPrefs === buildRerankSystem(PROFILE, EMPTY_PREFS), "all-empty prefs must be byte-identical to no-prefs");
  assert(!noPrefs.includes("Candidate stated preferences"), "no-prefs system must omit the prefs block");

  // 2) Non-empty prefs append the labeled block with only the set fields rendered.
  const withPrefs = buildRerankSystem(PROFILE, JUNIOR_PREFS);
  assert(withPrefs.startsWith(noPrefs), "the prefs system must be the no-prefs system PLUS an appended block");
  assert(withPrefs.includes("=== Candidate stated preferences ==="), "must label the prefs block");
  assert(withPrefs.includes("Target years of experience: 0-2"), "must render the YoE band (0-2)");
  assert(withPrefs.includes("Salary preference: from 120000"), "must render only-min salary as 'from'");
  // only-min must NOT render a ceiling: the salary LINE is "from 120000", with no range dash or "up to".
  // (Scope the negative to the salary line — the rubric prose itself contains "up to" elsewhere.)
  assert(!/Salary preference:.*(?:up to|-)/.test(withPrefs), "only-min salary must have no ceiling on its line");
  assert(withPrefs.includes("Dealbreakers (avoid): crypto"), "must render the dealbreaker avoid line");

  // 3) System built ONCE and identical across chunks (cache-stable). chunkSize 1 over 3 candidates → 3
  //    calls, all handed the SAME system, equal to buildRerankSystem(profile, prefs).
  {
    const { call, systems } = levelAwareStub();
    await rerankCandidates(PROFILE, CANDS, call, { prefs: JUNIOR_PREFS, chunkSize: 1 });
    assert(systems.length === 3, `expected one call per candidate, got ${systems.length}`);
    assert(new Set(systems).size === 1, "every chunk must receive the IDENTICAL system string");
    assert(systems[0] === withPrefs, "the per-chunk system must equal buildRerankSystem(profile, prefs)");
  }

  // 4) Prefs are WIRED into scoring AND move ranking in the intended direction: with a low declared YoE
  //    band, the over-leveled Staff/Senior roles rank BELOW the level-matched "Software Engineer I". Without
  //    prefs the stub can't see a band, so the over-leveled role keeps its original lead. The ORDER must
  //    differ — proving the declared YoE band reaches the reranker.
  {
    const withLow = await rerankCandidates(PROFILE, CANDS, levelAwareStub().call, { prefs: JUNIOR_PREFS });
    const noLevel = await rerankCandidates(PROFILE, CANDS, levelAwareStub().call, { prefs: EMPTY_PREFS });
    assert(withLow.orderedIds[0] === 2, "with a low YoE band, the level-matched role (id 2) must rank first");
    assert(
      withLow.orderedIds.indexOf(1) > withLow.orderedIds.indexOf(2),
      "over-leveled Staff role (id 1) must rank below the matched role (id 2)",
    );
    assert(
      JSON.stringify(withLow.orderedIds) !== JSON.stringify(noLevel.orderedIds),
      "declared level must observably change the ranking vs no-prefs (proves prefs reach the scorer)",
    );
  }

  console.log(
    "test-rerank-prefs OK — empty prefs byte-identical (no cache bust), non-empty appends a labeled block " +
      "with only-set fields, system built once/identical across chunks, declared level wired into scoring " +
      "and drops the over-leveled role.",
  );
});

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
