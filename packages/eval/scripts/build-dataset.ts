/**
 * Build the real labeled set, writing data/dataset.jsonl (the committed, hermetic source of
 * truth) from two example shapes:
 *
 *  - LEGACY (2 seed examples): labeled against the FULL board of the original ~80-job corpus.
 *    Frozen verbatim in data/legacy-examples.jsonl and passed through untouched — their
 *    gitignored export can't be regenerated at today's corpus scale, and re-serializing risks
 *    churning committed bytes for nothing.
 *  - POOLED (the scale shape): one example per data/profiles/<id>.json, whose candidate pool is
 *    its data/pools/<id>.json snapshot (the union of retrieval arms — see build-pool.ts).
 *    Labels are honest only WITHIN the pool: unlabeled ≠ irrelevant, so full-corpus labeled
 *    metrics must never be computed from them.
 *
 * PROFILES are anonymized (from real CVs or public-dataset CVs) — NO PII (no names, contact,
 * employers, schools, URLs), only role focus / skills / target roles, per the README's PII rule.
 * LABELS are agent-drafted; the CV owner is the authority and refines goodIds in the per-profile
 * files, then re-runs this.
 *
 * Candidate snapshots store the RAW title/description (no trim): production's jobEmbeddingText
 * composes from the raw jobs.title, so trimming here would make the eval embed different text
 * than what ships, breaking the "embed identically to ingestion" invariant. (Audit prints trim
 * for readability only.)
 *
 *   pnpm --filter @opusfinder/eval build:dataset      # after build:pool + labeling
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runScript } from "@opusfinder/shared/script";

import { parseDatasetLines } from "../src/dataset";
import { PKG_ROOT } from "../src/runner";
import type { EvalExample, EvalJob } from "../src/types";
import { loadAllProfileFiles, loadPoolFile } from "./pooling";

/** The frozen legacy lines, verbatim: validated through the real loader, but emitted as the raw
 *  strings so the committed bytes can never churn. */
function legacyLines(): string[] {
  const path = join(PKG_ROOT, "data", "legacy-examples.jsonl");
  const text = readFileSync(path, "utf8");
  const examples = parseDatasetLines(text, "legacy-examples.jsonl");
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("//") && !l.startsWith("#"));
  console.error(`legacy: ${examples.length} frozen full-board example(s)`);
  return lines;
}

function main(): void {
  const lines = legacyLines();

  for (const { profile, goodIds, notes } of loadAllProfileFiles()) {
    const pool = loadPoolFile(profile.id);
    const byId = new Map(pool.candidates.map((c) => [c.id, c]));
    const candidateJobs: EvalJob[] = pool.candidates.map((c) => ({
      id: c.id,
      title: c.title,
      descriptionText: c.descriptionText,
      locations: c.locations,
      remote: c.remote,
    }));

    console.error(`\n[${profile.id}] ${goodIds.length} good of ${candidateJobs.length} pooled:`);
    for (const goodId of goodIds) {
      const j = byId.get(goodId);
      if (!j) {
        throw new Error(
          `good id ${goodId} (${profile.id}) is not in the pool snapshot — stale label after a ` +
            `pool rebuild? Re-label against the current data/pools/${profile.id}.json.`,
        );
      }
      console.error(`  ${String(goodId).padStart(6)}  ${j.title.trim()}`);
    }
    const example: EvalExample = { profile, candidateJobs, expectedGoodIds: goodIds, notes };
    lines.push(JSON.stringify(example));
  }

  const header =
    "# Real labeled set (Phase 5). Profiles anonymized (NO PII). 2 legacy examples = full original\n" +
    "# board; pooled examples = per-profile retrieval-arm union (labels honest only within the pool\n" +
    "# — unlabeled != irrelevant). Owner-authoritative labels live in data/profiles/*.json.\n" +
    "# Regenerate: `pnpm --filter @opusfinder/eval build:dataset` (after build:pool). One example/line.\n";
  const content = `${header}${lines.join("\n")}\n`;
  // Validate through the EXACT load-time path before committing: the generation boundary must not
  // emit a dataset.jsonl the loader would reject (contentless profile/job, duplicate candidate ids,
  // out-of-pool good id). parseDatasetLines throws with a line number on any violation.
  const examples = parseDatasetLines(content, "build-dataset output");
  writeFileSync(join(PKG_ROOT, "data", "dataset.jsonl"), content, "utf8");
  console.error(`\nWrote data/dataset.jsonl: ${examples.length} examples.`);
}

await runScript("Build", main);
