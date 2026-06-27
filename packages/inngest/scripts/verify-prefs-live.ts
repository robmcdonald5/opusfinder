/**
 * Preferences live gate (3h) — exercises the location-filter + YoE-soft-signal behavioral changes against
 * REAL jobs + REAL Haiku, without the Inngest dev stack / Sonnet batch / email send. NEEDS DATABASE_URL +
 * ANTHROPIC_API_KEY.
 *   Part A — location filter (deterministic, no LLM): retrieve under each LocationMode and confirm
 *            remote_only → only remote, onsite_only → only on-site (the one real filter).
 *   Part B — YoE soft signal (real Haiku rerank): rerank the same candidate pool with NO prefs vs a low
 *            YoE band, and report how "over-leveled" titles move — the too-senior fix as a before/after.
 *   pnpm --filter @opusfinder/inngest exec tsx scripts/verify-prefs-live.ts [<userId>]
 */
import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { getProfileForDigest, retrieveCandidatesForProfile } from "@opusfinder/db/repos";
import { runScript } from "@opusfinder/shared/script";
import type { LocationMode, PromptPreferences, UserId } from "@opusfinder/shared";

import { buildDigestDeps } from "../src/deps";

const USER = (process.argv[2] ?? "cda5e3ef-e387-4c9f-9709-194d3d2fe11e") as UserId;
const RECENCY = 3650; // ignore recency for the gate — we want a populated pool, not a freshness test
const SENIOR_RE = /\b(staff|principal|distinguished|director|vp|head of|lead|senior|sr\.?)\b/i;

await runScript("verify-prefs-live", async () => {
  const db = createDb(getDatabaseUrl());
  const profile = await getProfileForDigest(db, USER);
  if (!profile?.embedding) throw new Error(`user ${USER} has no profile embedding — pick a CV-ingested user`);
  console.log(
    `profile ${String(USER).slice(0, 8)}… — targets: ${profile.structured.targetRoles.join(", ") || "(none)"}; ` +
      `${profile.structured.skills.length} skills\n`,
  );

  console.log("PART A — location filter (deterministic, real jobs):");
  for (const mode of ["any", "remote_only", "onsite_only"] as LocationMode[]) {
    const c = await retrieveCandidatesForProfile(db, profile.embedding, {
      locationMode: mode,
      recencyDays: RECENCY,
      limit: 50,
    });
    const remote = c.filter((x) => x.remote).length;
    console.log(`  ${mode.padEnd(12)} → ${c.length} candidates (remote=${remote}, on-site=${c.length - remote})`);
  }
  const remoteOnly = await retrieveCandidatesForProfile(db, profile.embedding, {
    locationMode: "remote_only",
    recencyDays: RECENCY,
    limit: 50,
  });
  const onsiteOnly = await retrieveCandidatesForProfile(db, profile.embedding, {
    locationMode: "onsite_only",
    recencyDays: RECENCY,
    limit: 50,
  });
  assert(remoteOnly.every((c) => c.remote), "remote_only must return ONLY remote jobs");
  assert(onsiteOnly.every((c) => !c.remote), "onsite_only must return ONLY on-site jobs");
  console.log("  ✓ remote_only → all remote; onsite_only → all on-site (exclusion verified)\n");

  console.log("PART B — YoE soft signal on ranking (real Haiku rerank, baseline vs low YoE band):");
  const pool = (
    await retrieveCandidatesForProfile(db, profile.embedding, { recencyDays: RECENCY, limit: 26 })
  ).map((c) => ({ id: c.id, title: c.title, descriptionText: c.descriptionText.slice(0, 2000) }));
  if (pool.length === 0) throw new Error("no candidates to rerank — is the jobs table empty/un-embedded?");
  const titleOf = new Map(pool.map((c) => [c.id, c.title]));

  const deps = buildDigestDeps();
  const lowYoe: PromptPreferences = { yoeMin: 0, yoeMax: 2, minSalary: null, maxSalary: null, dealbreakers: [] };
  console.log(`  reranking ${pool.length} candidates twice (this calls Haiku)…`);
  const base = await deps.rerank(profile.structured, pool);
  const band = await deps.rerank(profile.structured, pool, lowYoe);

  const baseRank = new Map(base.orderedIds.map((id, i) => [id, i + 1]));
  const bandRank = new Map(band.orderedIds.map((id, i) => [id, i + 1]));
  const show = (label: string, ids: number[]) => {
    console.log(`  ${label}:`);
    for (const id of ids.slice(0, 6)) {
      const senior = SENIOR_RE.test(titleOf.get(id) ?? "") ? " [senior-ish]" : "";
      console.log(`     ${(titleOf.get(id) ?? `job ${id}`).slice(0, 60)}${senior}`);
    }
  };
  show("baseline top-6 (no prefs)", base.orderedIds);
  show("low-YoE-band top-6", band.orderedIds);

  // How did senior-ish titles move? A low YoE band should, on average, push them DOWN.
  const seniorIds = pool.map((c) => c.id).filter((id) => SENIOR_RE.test(titleOf.get(id) ?? ""));
  let movedDown = 0;
  let movedUp = 0;
  console.log("  senior-ish title rank deltas (baseline → low-YoE; +N = dropped):");
  for (const id of seniorIds) {
    const baseRankOf = baseRank.get(id) ?? 0;
    const bandRankOf = bandRank.get(id) ?? 0;
    const delta = bandRankOf - baseRankOf;
    if (delta > 0) movedDown++;
    else if (delta < 0) movedUp++;
    console.log(`     #${baseRankOf} → #${bandRankOf} (${delta >= 0 ? "+" : ""}${delta})  ${(titleOf.get(id) ?? "").slice(0, 50)}`);
  }
  console.log(
    `\n  ${seniorIds.length} senior-ish role(s): ${movedDown} dropped, ${movedUp} rose under the low YoE band. ` +
      `(Hypothesis: the band pushes over-leveled roles down; skills-overlap still dominates, so this is a ` +
      `directional measurement, not a binary pass — see PHASE_F3_PLAN.md §9.)`,
  );
  console.log(`  rerank cache: baseline read=${base.cache.readInputTokens} create=${base.cache.creationInputTokens}`);

  console.log("\nverify-prefs-live OK — location filter excludes correctly; YoE band reaches the reranker.");
});

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
