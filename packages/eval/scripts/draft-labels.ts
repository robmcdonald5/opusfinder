/**
 * Draft the pooled labels for each per-profile label file: judge every candidate in
 * data/pools/<id>.json against the profile, write the `good` ids into data/profiles/<id>.json, and
 * emit a human review sheet to data/reviews/<id>.md.
 *
 * THE OWNER IS THE LABELING AUTHORITY — this script produces a DRAFT. The eval set's whole value is
 * that its ground truth is trustworthy; an unreviewed LLM label set would measure how well retrieval
 * agrees with one model, not how well it matches people. So the output is deliberately shaped for
 * review rather than for silent consumption: the judge's rubric is one readable file
 * (label-judge.ts), every verdict carries a checkable one-sentence reason, and its honest
 * uncertainty is surfaced as a separate `borderline` band instead of being rounded away.
 *
 * Labels are honest only WITHIN each pool (unlabeled ≠ irrelevant) — the load-bearing property of
 * this whole flow. See build-pool.ts for why the pool is a three-arm union.
 *
 *   pnpm --filter @opusfinder/eval draft-labels -- --profile it-manager   # one profile
 *   pnpm --filter @opusfinder/eval draft-labels                           # every unlabeled profile
 *   pnpm --filter @opusfinder/eval draft-labels -- --profile it-manager --limit 3   # wiring smoke
 *   pnpm --filter @opusfinder/eval draft-labels -- --profile it-manager --force     # redraft
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ModelAlias } from "@opusfinder/llm";
import { backoff } from "@opusfinder/shared/async";
import { runScript } from "@opusfinder/shared/script";

import { getFlag } from "../src/cli";
import { PKG_ROOT, relativeToPkg } from "../src/runner";
import { judgeCandidate, buildJudgeSystem, VERDICTS, type Verdict } from "./label-judge";
import {
  loadAllProfileFiles,
  loadProfileFile,
  loadPoolFile,
  poolPath,
  PROFILES_DIR,
  type LabeledProfileFile,
  type PoolCandidate,
  type PoolFile,
} from "./pooling";

const REVIEWS_DIR = join(PKG_ROOT, "data", "reviews");
/**
 * Sonnet by default, not the haiku the rest of the tooling uses. Ground truth is the one artifact
 * here whose errors are invisible later — a bad label doesn't fail, it silently rescores every
 * future run — and a stronger judge costs a few dollars across the whole set while cutting the
 * owner's review burden, which is the genuinely expensive resource. `--model haiku` for a cheap run.
 */
const DEFAULT_MODEL: ModelAlias = "sonnet";
const DEFAULT_CONCURRENCY = 6;
/** Retries per candidate before the run fails. A dropped judgement would land as an absent label,
 *  i.e. a silent "not good" — so transient errors are retried and a persistent one fails LOUD. */
const MAX_RETRIES = 2;

interface JudgedCandidate {
  candidate: PoolCandidate;
  verdict: Verdict;
  reason: string;
}

interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
}

function parseModel(raw: string | undefined): ModelAlias {
  if (raw === undefined) return DEFAULT_MODEL;
  if (raw !== "haiku" && raw !== "sonnet") {
    throw new Error(`--model must be "haiku" or "sonnet" (got "${raw}").`);
  }
  return raw;
}

function parsePositiveInt(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer (got "${raw}").`);
  return n;
}

/** Judge every candidate through a bounded worker pool (the repo's cursor+workers idiom, as in
 *  discovery/probe.ts). Results are written by index, so the output keeps POOL order regardless of
 *  completion order — the sheet and the run log must not shuffle run-to-run. */
async function judgeAll(
  profileFile: LabeledProfileFile,
  candidates: PoolCandidate[],
  model: ModelAlias,
  concurrency: number,
  totals: Totals,
): Promise<JudgedCandidate[]> {
  const system = buildJudgeSystem(profileFile.profile);
  const out = new Array<JudgedCandidate>(candidates.length);
  let cursor = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= candidates.length) return;
      const candidate = candidates[i];
      if (!candidate) continue;

      let lastErr: unknown;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const result = await judgeCandidate(system, candidate, model);
          totals.inputTokens += result.usage.inputTokens;
          totals.outputTokens += result.usage.outputTokens;
          totals.cacheCreation += result.cache.creationInputTokens;
          totals.cacheRead += result.cache.readInputTokens;
          out[i] = { candidate, verdict: result.verdict, reason: result.reason };
          done++;
          console.error(
            `  [${String(done).padStart(3)}/${candidates.length}] ${result.verdict.padEnd(10)} ` +
              `#${candidate.id} ${candidate.title.trim().slice(0, 64)}`,
          );
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < MAX_RETRIES) await backoff(attempt);
        }
      }
      if (!out[i]) {
        throw new Error(
          `judging candidate #${candidate.id} failed after ${MAX_RETRIES + 1} attempts: ` +
            `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
          { cause: lastErr },
        );
      }
    }
  };

  const workers = Math.min(Math.max(concurrency, 1), Math.max(candidates.length, 1));
  await Promise.all(Array.from({ length: workers }, worker));
  return out;
}

/** Which arm(s) nominated a candidate, with each arm's rank — the owner's cue for WHY something is
 *  in the pool at all (a random-arm row scoring "good" is a genuinely interesting signal). */
function provenance(c: PoolCandidate): string {
  const parts = c.arms.map((arm) => {
    if (arm === "voyage") {
      const d = c.voyageDistance === undefined ? "" : ` d=${c.voyageDistance.toFixed(3)}`;
      return `voyage #${c.voyageRank ?? "?"}${d}`;
    }
    if (arm === "fts") return `fts #${c.ftsRank ?? "?"}`;
    return "random";
  });
  return parts.join(" · ");
}

/** Collapse internal whitespace: both scraped titles and model-written reasons can contain newlines,
 *  and a newline mid-row silently breaks the bullet it belongs to into orphaned lines. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function locationLine(c: PoolCandidate): string {
  const where = c.locations.length > 0 ? c.locations.join(", ") : "—";
  return c.remote ? `${where} · remote` : where;
}

function renderReviewSheet(
  profileFile: LabeledProfileFile,
  pool: PoolFile,
  judged: JudgedCandidate[],
  model: ModelAlias,
  partial: boolean,
): string {
  const { profile } = profileFile;
  const by = (v: Verdict): JudgedCandidate[] => judged.filter((j) => j.verdict === v);
  const good = by("good");
  const borderline = by("borderline");
  const bad = by("bad");

  const lines: string[] = [];
  lines.push(`# Label review — ${profile.id}`);
  lines.push("");
  if (partial) {
    lines.push(
      `> **PARTIAL DRAFT — ${judged.length} of ${pool.candidates.length} candidates judged** ` +
        `(\`--limit\`). A wiring smoke test, not a label set; \`data/profiles/${profile.id}.json\` was NOT written.`,
    );
    lines.push("");
  }
  lines.push(
    `**Draft:** \`${model}\`, one call per candidate, temperature 0 — ` +
      `**${good.length} good · ${borderline.length} borderline · ${bad.length} bad** of ${judged.length} judged.`,
  );
  lines.push(
    `**Pool:** \`data/pools/${profile.id}.json\` — ${pool.candidates.length} candidates drawn from ` +
      `${pool.corpus.eligibleJobs.toLocaleString("en-US")} eligible jobs ` +
      `(arms: voyage ${pool.arms.voyageK} / fts ${pool.arms.ftsK} / random ${pool.arms.randomK}, ` +
      `${pool.arms.recencyDays}d recency).`,
  );
  lines.push("");
  lines.push(
    "**You are the labeling authority — this is a draft.** To accept it, do nothing. To change it, " +
      `edit \`goodIds\` in \`data/profiles/${profile.id}.json\` (ids are in this sheet), then re-run ` +
      "`pnpm --filter @opusfinder/eval build:dataset`. **Start with the borderline section**: those " +
      "are the judgements the model itself was unsure of, so that is where your attention changes " +
      "the ground truth most.",
  );
  lines.push("");
  lines.push(
    "Labels are honest only WITHIN this pool: unlabeled ≠ irrelevant, so never read a full-corpus " +
      "recall out of them.",
  );
  lines.push("");
  lines.push("## Drafted goodIds");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(good.map((j) => j.candidate.id)));
  lines.push("```");
  lines.push("");
  lines.push("## Profile as the judge saw it");
  lines.push("");
  lines.push(`${profile.summary}`);
  lines.push("");
  lines.push(`**Target roles:** ${profile.targetRoles.join(" · ")}`);
  lines.push("");
  lines.push(`**Skills:** ${profile.skills.join(" · ")}`);
  lines.push("");
  lines.push(
    "_The judge saw exactly the above (the same text the profile embedding is built from). It did " +
      "NOT see the locations shown below — the rubric forbids judging on location, remote, or " +
      "employer, so they are withheld from it and shown here only as context for you._",
  );
  lines.push("");

  const section = (title: string, rows: JudgedCandidate[], detailed: boolean): void => {
    lines.push(`## ${title} (${rows.length})`);
    lines.push("");
    if (rows.length === 0) {
      lines.push("_none_");
      lines.push("");
      return;
    }
    for (const { candidate, reason } of rows) {
      if (detailed) {
        // Metadata on the bullet, reason as an indented paragraph: reads correctly BOTH rendered
        // and as raw text in an editor, which is how these actually get reviewed.
        lines.push(
          `- **\`${candidate.id}\`** — ${oneLine(candidate.title)} · _${provenance(candidate)}_ · ${locationLine(candidate)}`,
        );
        lines.push("");
        lines.push(`  ${oneLine(reason)}`);
        lines.push("");
      } else {
        lines.push(`- \`${candidate.id}\` — ${oneLine(candidate.title)} — ${oneLine(reason)}`);
      }
    }
    lines.push("");
  };

  section("GOOD — these become the labels", good, true);
  section("BORDERLINE — read these first", borderline, true);
  section("BAD", bad, false);

  return `${lines.join("\n")}\n`;
}

/** Provenance for the committed label file. No timestamp, by the same convention as the pool file
 *  and the reports: a re-run that changes nothing must not churn committed bytes. */
function draftNotes(judged: JudgedCandidate[], model: ModelAlias, pool: PoolFile): string {
  const count = (v: Verdict): number => judged.filter((j) => j.verdict === v).length;
  return (
    `Labels drafted by scripts/draft-labels.ts (${model}, one call per candidate, temperature 0) ` +
    `over the ${pool.candidates.length}-candidate pool: ` +
    `${VERDICTS.map((v) => `${count(v)} ${v}`).join(" / ")}. ` +
    `Pool-scoped: honest only within this pool (unlabeled != irrelevant).`
  );
}

async function draftFor(
  profileFile: LabeledProfileFile,
  model: ModelAlias,
  concurrency: number,
  limit: number | undefined,
  totals: Totals,
): Promise<void> {
  const { profile } = profileFile;
  const pool = loadPoolFile(profile.id);
  const candidates = limit === undefined ? pool.candidates : pool.candidates.slice(0, limit);
  if (candidates.length === 0) {
    throw new Error(`${relativeToPkg(poolPath(profile.id))} has no candidates — rebuild with build:pool.`);
  }
  const partial = candidates.length < pool.candidates.length;

  console.error(
    `\n[${profile.id}] judging ${candidates.length}${partial ? ` of ${pool.candidates.length}` : ""} ` +
      `candidate(s) with ${model}, concurrency ${concurrency}`,
  );
  const judged = await judgeAll(profileFile, candidates, model, concurrency, totals);

  mkdirSync(REVIEWS_DIR, { recursive: true });
  const sheetPath = join(REVIEWS_DIR, `${profile.id}.md`);
  writeFileSync(sheetPath, renderReviewSheet(profileFile, pool, judged, model, partial), "utf8");
  console.error(`  wrote ${relativeToPkg(sheetPath)}`);

  // A partial run is a wiring smoke test, not a label set: writing its goodIds would commit a label
  // set whose "not good" half was never actually judged.
  if (partial) {
    console.error(`  SKIPPED writing the label file (--limit): a partial draft is not a label set.`);
    return;
  }

  const goodIds = judged.filter((j) => j.verdict === "good").map((j) => j.candidate.id);
  const updated: LabeledProfileFile = {
    ...profileFile,
    goodIds,
    notes: draftNotes(judged, model, pool),
  };
  const filePath = join(PROFILES_DIR, `${profile.id}.json`);
  writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  console.error(`  wrote ${relativeToPkg(filePath)} — ${goodIds.length} good id(s)`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = getFlag(args, "--profile");
  const model = parseModel(getFlag(args, "--model"));
  const concurrency = parsePositiveInt(getFlag(args, "--concurrency"), "--concurrency", DEFAULT_CONCURRENCY);
  const limit = getFlag(args, "--limit") === undefined
    ? undefined
    : parsePositiveInt(getFlag(args, "--limit"), "--limit", 1);
  const force = args.includes("--force");

  const targets = only ? [loadProfileFile(join(PROFILES_DIR, `${only}.json`))] : loadAllProfileFiles();
  if (targets.length === 0) {
    throw new Error(`no profile files in ${relativeToPkg(PROFILES_DIR)} — nothing to label.`);
  }

  const totals: Totals = { inputTokens: 0, outputTokens: 0, cacheCreation: 0, cacheRead: 0 };
  let drafted = 0;
  for (const target of targets) {
    // Already-labeled profiles are protected, but differently by intent: naming one explicitly is a
    // request this script must not quietly ignore (fail loud), while a sweep over every profile
    // should resume where it left off rather than re-spend on finished work (skip). --force overrides.
    if (target.goodIds.length > 0 && !force) {
      const msg =
        `${target.profile.id} already has ${target.goodIds.length} label(s) — ` +
        `re-drafting would discard owner refinements. Pass --force to overwrite.`;
      if (only) throw new Error(msg);
      console.error(`[${target.profile.id}] SKIPPED: ${msg}`);
      continue;
    }
    await draftFor(target, model, concurrency, limit, totals);
    drafted++;
  }

  // Report the cache counters rather than assuming the breakpoint engaged: cacheSystem is a silent
  // no-op below the model's minimum cacheable prefix. Creation-without-reads is a THIRD state (the
  // opening concurrent burst all misses, since none of them has written the entry yet) — reading it
  // as "cache off" would misdiagnose a cache that is working.
  const cacheNote =
    totals.cacheCreation === 0 && totals.cacheRead === 0
      ? " (never engaged — prefix is below the model's minimum cacheable size)"
      : totals.cacheRead === 0
        ? " (written but never reused — expected only when the run is smaller than its concurrency)"
        : "";
  console.error(
    `\nDrafted ${drafted} profile(s). Tokens: ${totals.inputTokens.toLocaleString("en-US")} in / ` +
      `${totals.outputTokens.toLocaleString("en-US")} out; prompt cache: ` +
      `${totals.cacheCreation.toLocaleString("en-US")} created / ${totals.cacheRead.toLocaleString("en-US")} read` +
      `${cacheNote}.`,
  );
}

await runScript("DraftLabels", main);
