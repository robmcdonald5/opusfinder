/**
 * Check the CV extraction against the owner-checked key (data/cv-extract/keys/): run the production
 * transcribe → structure → scrub calls over the test CVs and score each profile field by field. Run it
 * before any change to the CV prompts or schema, and bump CV_EXTRACT_VERSION with the change: each
 * version's profiles land in their own directory, so `score` compares every version kept there.
 * Not a CI gate: the model is live.
 *
 *   pnpm --filter @opusfinder/eval run cv-extract fetch      download the CVs the keys pin, and verify their checksums
 *   pnpm --filter @opusfinder/eval run cv-extract run        extract with the current prompt → data/cv-extract/v<N>/
 *   pnpm --filter @opusfinder/eval run cv-extract score      score every version → reports/cv-extract.json
 *   pnpm --filter @opusfinder/eval run cv-extract review     write the key as a review sheet (data/reviews/)
 *
 * `run --only <id,id>` limits it to some CVs; `run --force` re-extracts ones already done. The PDFs and
 * their transcripts stay under the gitignored data/cvs/; a cached transcript is reused, so a prompt
 * change re-pays only the structuring call. `run` needs OPENROUTER_API_KEY (packages/llm/.env).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CV_EXTRACT_VERSION, structureCv, transcribeCv } from "@opusfinder/llm/node";
import { getOpenRouterApiKey } from "@opusfinder/llm/env";
import { MIN_TRANSCRIPT_CHARS, scrubProfilePii, type StructuredProfile } from "@opusfinder/shared";
import { runScript } from "@opusfinder/shared/script";

import { getFlag } from "../src/cli";
import {
  CV_GROUPS,
  loadCvKeys,
  scoreProfile,
  summarize,
  type CvKey,
  type ScoreSummary,
  type Tally,
} from "../src/cv-extract-key";
import { PKG_ROOT, relativeToPkg } from "../src/runner";

const DATA = join(PKG_ROOT, "data", "cv-extract");
const KEYS = join(DATA, "keys");
const CVS = join(PKG_ROOT, "data", "cvs", "cv-extract");
const REPORT = join(PKG_ROOT, "reports", "cv-extract.json");
const SHEET = join(PKG_ROOT, "data", "reviews", "cv-extract.md");
const CONCURRENCY = 4;

const sourceUrl = (key: CvKey) =>
  `https://huggingface.co/datasets/${key.source.dataset}/resolve/${key.source.revision}/${key.source.path}`;
const pdfPath = (key: CvKey) => join(CVS, `${key.id}.pdf`);
const transcriptPath = (key: CvKey) => join(CVS, `${key.id}.txt`);
const versionDir = (version: number) => join(DATA, `v${version}`);

/** Download each CV at its pinned dataset commit and check it, and any copy already here, against the key's SHA-256. */
async function fetchCvs(keys: CvKey[]): Promise<void> {
  mkdirSync(CVS, { recursive: true });
  for (const key of keys) {
    const had = existsSync(pdfPath(key));
    if (!had) {
      const res = await fetch(sourceUrl(key));
      if (!res.ok) throw new Error(`${key.id}: ${res.status} from ${sourceUrl(key)}`);
      writeFileSync(pdfPath(key), new Uint8Array(await res.arrayBuffer()));
    }
    const sha256 = createHash("sha256")
      .update(readFileSync(pdfPath(key)))
      .digest("hex");
    if (sha256 !== key.source.sha256) {
      throw new Error(
        `${key.id}: ${relativeToPkg(pdfPath(key))} has SHA-256 ${sha256}, the key says ${key.source.sha256}`,
      );
    }
    if (!had) console.log(`fetched ${key.id}`);
  }
  console.log(`${keys.length} CVs present and matching their checksums`);
}

/** The key's spend so far in USD, to report what a run cost. Undefined if the lookup fails. */
async function keyUsageUsd(): Promise<number | undefined> {
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${getOpenRouterApiKey()}` },
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { data?: { usage?: number } };
  return body.data?.usage;
}

async function extract(key: CvKey): Promise<StructuredProfile> {
  let transcript: string;
  if (existsSync(transcriptPath(key))) {
    transcript = readFileSync(transcriptPath(key), "utf8");
  } else {
    if (!existsSync(pdfPath(key)))
      throw new Error(`${key.id}: no PDF; run \`cv-extract fetch\` first`);
    transcript = await transcribeCv(readFileSync(pdfPath(key)));
    if (transcript.trim().length < MIN_TRANSCRIPT_CHARS)
      throw new Error(`${key.id}: transcript too short`);
    writeFileSync(transcriptPath(key), transcript);
  }
  return scrubProfilePii(await structureCv(transcript));
}

async function run(keys: CvKey[]): Promise<void> {
  const out = versionDir(CV_EXTRACT_VERSION);
  mkdirSync(out, { recursive: true });
  const args = process.argv.slice(3);
  const only = getFlag(args, "--only")?.split(",");
  const force = args.includes("--force");
  const todo = keys.filter(
    (key) =>
      (!only || only.includes(key.id)) && (force || !existsSync(join(out, `${key.id}.json`))),
  );
  const before = await keyUsageUsd();
  const queue = [...todo];
  const failed: string[] = [];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let key = queue.shift(); key; key = queue.shift()) {
        try {
          writeFileSync(
            join(out, `${key.id}.json`),
            `${JSON.stringify(await extract(key), null, 2)}\n`,
          );
          console.log(`extracted ${key.id}`);
        } catch (err) {
          failed.push(key.id);
          console.error(`${key.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }),
  );
  const after = await keyUsageUsd();
  const cost =
    before !== undefined && after !== undefined ? ` ~$${(after - before).toFixed(3)}` : "";
  console.log(
    `v${CV_EXTRACT_VERSION}: ${todo.length - failed.length} of ${todo.length} extracted${cost}`,
  );
  if (failed.length > 0) {
    console.error(`failed: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}

interface VersionReport extends ScoreSummary {
  cvs: number;
  /** Every wrong field, by CV. */
  wrong: Record<string, Record<string, string[]>>;
}

function score(keys: CvKey[]): void {
  const versions = readdirSync(DATA)
    .filter((name) => /^v\d+$/.test(name))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const report: Record<string, VersionReport> = {};
  for (const version of versions) {
    const scored = keys.flatMap((key) => {
      const file = join(DATA, version, `${key.id}.json`);
      if (!existsSync(file)) return [];
      const profile = JSON.parse(readFileSync(file, "utf8")) as StructuredProfile;
      return [{ key, profile, results: scoreProfile(profile, key) }];
    });
    const wrong: VersionReport["wrong"] = {};
    for (const { key, results } of scored) {
      const bad = results.filter((r) => !r.correct);
      if (bad.length > 0) wrong[key.id] = Object.fromEntries(bad.map((r) => [r.field, r.problems]));
    }
    report[version] = { cvs: scored.length, ...summarize(scored), wrong };
  }
  const groups = Object.fromEntries(
    CV_GROUPS.map((g) => [g, keys.filter((k) => k.group === g).length]),
  );
  writeFileSync(
    REPORT,
    `${JSON.stringify({ cvs: keys.length, groups, versions: report }, null, 2)}\n`,
  );

  const pct = (t?: Tally) =>
    t && t.total > 0
      ? `${((100 * t.correct) / t.total).toFixed(1)}% (${t.correct}/${t.total})`
      : "n/a";
  console.log(
    `${keys.length} CVs: ${Object.entries(groups)
      .map(([g, n]) => `${g} ${n}`)
      .join(", ")}`,
  );
  for (const [version, r] of Object.entries(report)) {
    console.log(`\n${version} (${r.cvs} CVs)`);
    console.log(`  all fields            ${pct(r.overall)}`);
    console.log(`  fields v1 also has    ${pct(r.sharedFields)}`);
    console.log(`  fields new in v2      ${pct(r.factFields)}`);
    for (const g of CV_GROUPS) console.log(`  ${g.padEnd(21)} ${pct(r.byGroup[g])}`);
    for (const [field, t] of Object.entries(r.byField))
      console.log(`  · ${field.padEnd(19)} ${pct(t)}`);
    console.log(
      `  required credentials named in the embedded text: ${pct(r.credentialsMentioned)}`,
    );
    for (const [id, fields] of Object.entries(r.wrong)) {
      for (const [field, problems] of Object.entries(fields))
        console.log(`  ✗ ${id} ${field}: ${problems.join("; ")}`);
    }
  }
  console.log(`\nreport: ${relativeToPkg(REPORT)}`);
}

function review(keys: CvKey[]): void {
  const list = (items: string[]) => (items.length > 0 ? items.join("; ") : "_none_");
  const opt = (entry: { optional?: true }) => (entry.optional ? " _(allowed, not required)_" : "");
  const out = [
    "# CV extraction key: review sheet",
    "",
    `${keys.length} CVs. For each, open the PDF and check that the expected values are what the CV says.`,
    "Fix a wrong one in `data/cv-extract/keys/<id>.json`. An entry marked _allowed, not required_ may be",
    "extracted or not; anything else extracted counts as wrong. Aliases after `/` are other accepted wordings.",
    "",
  ];
  for (const key of keys) {
    const e = key.expected;
    out.push(
      `## ${key.id} (${key.group})`,
      "",
      `PDF: ${sourceUrl(key)}`,
      "",
      `- **Credentials:** ${list(
        e.credentials.map(
          (c) =>
            `${[c.match.join(" / "), c.also?.join(" / ")].filter(Boolean).join(" + ")}` +
            `${c.issuer ? `, issuer ${c.issuer.join(" / ")}` : ""}` +
            `${c.status === null ? "" : `, status ${c.status}`}${c.expires === null ? "" : `, expires ${c.expires}`}${opt(c)}`,
        ),
      )}`,
      `- **Education:** ${list(
        e.education.map(
          (ed) =>
            `${ed.level.join(" | ")}${ed.field ? ` in ${ed.field.join(" / ")}` : ""}` +
            `${ed.completed === true ? "" : `, completed: ${ed.completed}`}${opt(ed)}`,
        ),
      )}`,
      `- **Years stated:** ${list(e.years.map((y) => `${y.years} (${y.slot})${opt(y)}`))}`,
      `- **Languages:** ${list(e.languages.map((l) => `${l.match.join(" / ")}${opt(l)}`))}`,
      `- **Work authorisation:** ${e.workAuthorization ? e.workAuthorization.join(" / ") : "_none stated_"}`,
      `- **First target role contains:** ${e.targetRoles.join(" / ")}`,
      `- **Skills must include:** ${e.skills.map((g) => g.join(" / ")).join("; ")}`,
      `- **Summary must mention:** ${e.summary.map((g) => g.join(" / ")).join("; ")}`,
      ...(e.forbidden.length > 0 ? [`- **Must appear nowhere:** ${e.forbidden.join(", ")}`] : []),
      ...(key.judgementCalls.length > 0
        ? ["", "Judgement calls:", ...key.judgementCalls.map((c) => `- ${c}`)]
        : []),
      "",
    );
  }
  mkdirSync(join(PKG_ROOT, "data", "reviews"), { recursive: true });
  writeFileSync(SHEET, `${out.join("\n")}\n`);
  console.log(`review sheet: ${relativeToPkg(SHEET)}`);
}

await runScript("cv-extract", async () => {
  const keys = loadCvKeys(KEYS);
  const command = process.argv[2];
  if (command === "fetch") await fetchCvs(keys);
  else if (command === "run") await run(keys);
  else if (command === "score") score(keys);
  else if (command === "review") review(keys);
  else {
    console.error("Usage: cv-extract fetch | run [--only <id,id>] [--force] | score | review");
    process.exitCode = 1;
  }
});
