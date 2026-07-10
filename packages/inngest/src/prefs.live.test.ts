/**
 * LIVE gate (opt-in) for the preferences rerank against REAL Neon + REAL Haiku — the non-deterministic half
 * the old `scripts/verify-prefs-live.ts` owned. The DETERMINISTIC location filter (PART A) now lives in
 * @opusfinder/db retrieval.integration.test.ts (B16 / B16b); this gate exercises PART B: that
 * `buildDigestDeps().rerank` reaches Haiku and returns a well-formed ordering over a real candidate pool for
 * both a baseline and a low-YoE-band prompt. The directional YoE movement (senior-ish titles drop) is a
 * MEASUREMENT, not a binary pass (PHASE_F3 §9) — logged by the old script, never asserted here.
 *
 * NEVER runs in CI: gated on an EXPLICIT opt-in flag ON TOP of creds (PREFS_LIVE_TEST=1 + DATABASE_URL +
 * ANTHROPIC_API_KEY), in the no-MSW `live` project.
 *
 *   PREFS_LIVE_TEST=1 pnpm test:live
 */
import { describe, expect, it } from "vitest";

import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { getProfileForDigest, retrieveCandidatesForProfile } from "@opusfinder/db/repos";
import type { PromptPreferences, UserId } from "@opusfinder/shared";

import { buildDigestDeps } from "./deps";

const GATED =
  process.env.PREFS_LIVE_TEST !== "1" || !process.env.DATABASE_URL || !process.env.ANTHROPIC_API_KEY;
const USER = (process.env.PREFS_LIVE_USER ?? "cda5e3ef-e387-4c9f-9709-194d3d2fe11e") as UserId;

describe.skipIf(GATED)("preferences rerank (live: real Neon + Haiku)", () => {
  it("reranks a real pool baseline vs a low-YoE band, returning well-formed orderings", async () => {
    const db = createDb(getDatabaseUrl());
    const profile = await getProfileForDigest(db, USER);
    if (!profile?.embedding) {
      throw new Error(`user ${USER} has no profile embedding — pick a CV-ingested user via PREFS_LIVE_USER`);
    }

    const pool = (
      await retrieveCandidatesForProfile(db, profile.embedding, { recencyDays: 3650, limit: 26 })
    ).map((c) => ({ id: c.id, title: c.title, descriptionText: c.descriptionText.slice(0, 2000) }));
    expect(pool.length).toBeGreaterThan(0);
    const poolIds = new Set(pool.map((c) => c.id));

    const deps = buildDigestDeps();
    const lowYoe: PromptPreferences = {
      yoeMin: 0,
      yoeMax: 2,
      minSalary: null,
      maxSalary: null,
      dealbreakers: [],
    };
    const base = await deps.rerank(profile.structured, pool);
    const band = await deps.rerank(profile.structured, pool, lowYoe);

    for (const outcome of [base, band]) {
      expect(outcome.orderedIds.length).toBeGreaterThan(0);
      // Every ranked id is a real pool id, and its score is present — no fabricated/orphaned ids.
      for (const id of outcome.orderedIds) {
        expect(poolIds.has(id)).toBe(true);
        expect(outcome.scores.has(id)).toBe(true);
      }
      // The prompt-cache counters are populated (the live-only observability the old script logged).
      expect(Number.isFinite(outcome.cache.readInputTokens)).toBe(true);
      expect(Number.isFinite(outcome.cache.creationInputTokens)).toBe(true);
    }
  });
});
