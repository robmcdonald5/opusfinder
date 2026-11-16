/**
 * Extract the eval's test profiles and check the extraction: run the production transcribe → structure
 * → scrub calls over every CV in the registry (data/cv-extract/cvs.json), and score the CVs that have a
 * key (data/cv-extract/keys/) field by field. Run it before any change to the CV prompts or schema, and
 * bump CV_EXTRACT_VERSION with the change: each version's profiles land in their own directory, so
 * `score` compares every version kept there. Not a CI gate: the model is live.
 *
 *   pnpm --filter @opusfinder/eval run cv-extract fetch      download the dataset CVs, and verify every CV's checksum
 *   pnpm --filter @opusfinder/eval run cv-extract run        extract with the current prompt → data/cv-extract/v<N>/
 *   pnpm --filter @opusfinder/eval run cv-extract score      score every version → reports/cv-extract.json
 *   pnpm --filter @opusfinder/eval run cv-extract review     write the key as a review sheet (data/reviews/)
 *   pnpm --filter @opusfinder/eval run cv-extract list       the profile set: counts per group, source and version
 *
 * `run --only <id,id>` limits it to some CVs; `run --force` re-extracts ones already done. `run --repeat`
 * extracts the held-out CVs a second time from scratch into v<N>-run2/, so `score` can report what
 * changes between two runs. The downloaded PDFs and every transcript stay under the gitignored
 * data/cvs/; a cached transcript is reused, so a prompt change re-pays only the structuring call. `run`
 * needs OPENROUTER_API_KEY (packages/llm/.env).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CV_EXTRACT_VERSION, structureCv, transcribeCv } from "@opusfinder/llm/node";
import { getOpenRouterApiKey } from "@opusfinder/llm/env";
import {
  MIN_TRANSCRIPT_CHARS,
  profileExtractVersion,
  scrubProfilePii,
  type StructuredProfile,
} from "@opusfinder/shared";
import { runScript } from "@opusfinder/shared/script";

import { getFlag } from "../src/cli";
import {
  CV_GROUPS,
  FACT_FIELDS,
  loadCvKeys,
  scoreProfile,
  summarize,
  type CvKey,
  type FieldResult,
  type ScoreSummary,
  type Tally,
} from "../src/cv-extract-key";
import {
  CV_DATA_DIR,
  CV_DOWNLOADS_DIR,
  cvPdfPath,
  datasetCvUrl,
  isSynthetic,
  loadCvRegistry,
  parseStoredProfile,
  PROFILE_SET_VERSION,
  type CvEntry,
} from "../src/profile-set";
import { PKG_ROOT, relativeToPkg } from "../src/runner";

const KEYS = join(CV_DATA_DIR, "keys");
const REPORT = join(PKG_ROOT, "reports", "cv-extract.json");
const SHEET = join(PKG_ROOT, "data", "reviews", "cv-extract.md");
const CONCURRENCY = 4;

/** A second, from-scratch run of one version: its own profiles and its own transcripts. */
const REPEAT = "run2";
const versionDir = (version: number, repeat = false) =>
  join(CV_DATA_DIR, `v${version}${repeat ? `-${REPEAT}` : ""}`);
const transcriptPath = (cv: CvEntry, repeat = false) =>
  join(CV_DOWNLOADS_DIR, `${cv.id}${repeat ? `.${REPEAT}` : ""}.txt`);

/** Download each dataset CV at its pinned commit, and check every CV, synthetic ones and copies already
 *  here included, against the registry's SHA-256. */
async function fetchCvs(cvs: CvEntry[]): Promise<void> {
  mkdirSync(CV_DOWNLOADS_DIR, { recursive: true });
  for (const cv of cvs) {
    const path = cvPdfPath(cv);
    const had = existsSync(path);
    if (!had) {
      if (isSynthetic(cv.source)) throw new Error(`${cv.id}: ${relativeToPkg(path)} is missing`);
      const res = await fetch(datasetCvUrl(cv.source));
      if (!res.ok) throw new Error(`${cv.id}: ${res.status} from ${datasetCvUrl(cv.source)}`);
      writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
    }
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (sha256 !== cv.source.sha256) {
      throw new Error(
        `${cv.id}: ${relativeToPkg(path)} has SHA-256 ${sha256}, the registry says ${cv.source.sha256}`,
      );
    }
    if (!had) console.log(`fetched ${cv.id}`);
  }
  console.log(`${cvs.length} CVs present and matching their checksums`);
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

async function extract(cv: CvEntry, repeat: boolean): Promise<StructuredProfile> {
  const cached = transcriptPath(cv, repeat);
  let transcript: string;
  if (existsSync(cached)) {
    transcript = readFileSync(cached, "utf8");
  } else {
    if (!existsSync(cvPdfPath(cv)))
      throw new Error(`${cv.id}: no PDF; run \`cv-extract fetch\` first`);
    transcript = await transcribeCv(readFileSync(cvPdfPath(cv)));
    if (transcript.trim().length < MIN_TRANSCRIPT_CHARS)
      throw new Error(`${cv.id}: transcript too short`);
    writeFileSync(cached, transcript);
  }
  return scrubProfilePii(await structureCv(transcript));
}

async function run(cvs: CvEntry[], keys: CvKey[]): Promise<void> {
  const args = process.argv.slice(3);
  const only = getFlag(args, "--only")?.split(",");
  const force = args.includes("--force");
  const repeat = args.includes("--repeat");
  const out = versionDir(CV_EXTRACT_VERSION, repeat);
  mkdirSync(out, { recursive: true });
  mkdirSync(CV_DOWNLOADS_DIR, { recursive: true });
  const unknown = only?.filter((id) => !cvs.some((cv) => cv.id === id)) ?? [];
  if (unknown.length > 0) throw new Error(`not in the registry: ${unknown.join(", ")}`);
  const heldOut = new Set(keys.filter((key) => key.heldOut).map((key) => key.id));
  const todo = cvs.filter(
    (cv) =>
      (only ? only.includes(cv.id) : !repeat || heldOut.has(cv.id)) &&
      (force || !existsSync(join(out, `${cv.id}.json`))),
  );
  const before = await keyUsageUsd();
  const queue = [...todo];
  const failed: string[] = [];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let cv = queue.shift(); cv; cv = queue.shift()) {
        try {
          writeFileSync(
            join(out, `${cv.id}.json`),
            `${JSON.stringify(await extract(cv, repeat), null, 2)}\n`,
          );
          console.log(`extracted ${cv.id}`);
        } catch (err) {
          failed.push(cv.id);
          console.error(`${cv.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }),
  );
  const after = await keyUsageUsd();
  const cost =
    before !== undefined && after !== undefined ? ` ~$${(after - before).toFixed(3)}` : "";
  console.log(
    `${relativeToPkg(out)}: ${todo.length - failed.length} of ${todo.length} extracted${cost}`,
  );
  if (failed.length > 0) {
    console.error(`failed: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}

interface Scored {
  key: CvKey;
  profile: StructuredProfile;
  results: FieldResult[];
}

function scoreDir(dir: string, keys: CvKey[]): Scored[] {
  return keys.flatMap((key) => {
    const file = join(dir, `${key.id}.json`);
    if (!existsSync(file)) return [];
    const profile = parseStoredProfile(JSON.parse(readFileSync(file, "utf8")), file);
    return [{ key, profile, results: scoreProfile(profile, key) }];
  });
}

/** Every wrong field with its reasons, by CV. */
function wrongFields(scored: Scored[]): Record<string, Record<string, string[]>> {
  const wrong: Record<string, Record<string, string[]>> = {};
  for (const { key, results } of scored) {
    const bad = results.filter((r) => !r.correct);
    if (bad.length > 0) wrong[key.id] = Object.fromEntries(bad.map((r) => [r.field, r.problems]));
  }
  return wrong;
}

/** What changed between two from-scratch runs of one version over the same CVs. */
interface RepeatReport {
  cvs: number;
  run1: Tally;
  run2: Tally;
  /** Scored fields right in one run and wrong in the other, by CV. */
  flipped: Record<string, string[]>;
  /** Every field the second run got wrong, by CV. The first run's are the version's own `wrong`. */
  wrong: Record<string, Record<string, string[]>>;
  /** `facts` fields whose extracted value is not identical in the two runs, by CV. Most are rewordings. */
  reworded: Record<string, string[]>;
  factFields: number;
}

function compareRuns(first: Scored[], second: Scored[]): RepeatReport {
  const report: RepeatReport = {
    cvs: 0,
    run1: { correct: 0, total: 0 },
    run2: { correct: 0, total: 0 },
    flipped: {},
    wrong: wrongFields(second),
    reworded: {},
    factFields: 0,
  };
  for (const b of second) {
    const a = first.find((s) => s.key.id === b.key.id);
    if (!a) continue;
    report.cvs += 1;
    const flipped: string[] = [];
    for (const rb of b.results) {
      const ra = a.results.find((r) => r.field === rb.field);
      if (!ra) continue;
      report.run1.total += 1;
      report.run2.total += 1;
      if (ra.correct) report.run1.correct += 1;
      if (rb.correct) report.run2.correct += 1;
      if (ra.correct !== rb.correct) flipped.push(rb.field);
    }
    if (flipped.length > 0) report.flipped[b.key.id] = flipped;
    const reworded = FACT_FIELDS.filter(
      (field) =>
        JSON.stringify(a.profile.facts?.[field as keyof typeof a.profile.facts]) !==
        JSON.stringify(b.profile.facts?.[field as keyof typeof b.profile.facts]),
    );
    report.factFields += FACT_FIELDS.length;
    if (reworded.length > 0) report.reworded[b.key.id] = reworded;
  }
  return report;
}

interface VersionReport extends ScoreSummary {
  cvs: number;
  /** Every wrong field, by CV. */
  wrong: Record<string, Record<string, string[]>>;
  repeat?: RepeatReport;
}

function score(keys: CvKey[]): void {
  const versions = readdirSync(CV_DATA_DIR)
    .filter((name) => /^v\d+$/.test(name))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const report: Record<string, VersionReport> = {};
  for (const version of versions) {
    const scored = scoreDir(join(CV_DATA_DIR, version), keys);
    const wrong = wrongFields(scored);
    const repeated = scoreDir(join(CV_DATA_DIR, `${version}-${REPEAT}`), keys);
    report[version] = {
      cvs: scored.length,
      ...summarize(scored),
      wrong,
      ...(repeated.length > 0 && { repeat: compareRuns(scored, repeated) }),
    };
  }
  const groups = Object.fromEntries(
    CV_GROUPS.map((g) => [g, keys.filter((k) => k.group === g).length]),
  );
  const heldOut = keys.filter((k) => k.heldOut).length;
  writeFileSync(
    REPORT,
    `${JSON.stringify({ cvs: keys.length, heldOut, groups, versions: report }, null, 2)}\n`,
  );

  const pct = (t?: Tally) =>
    t && t.total > 0
      ? `${((100 * t.correct) / t.total).toFixed(1)}% (${t.correct}/${t.total})`
      : "n/a";
  console.log(
    `${keys.length} keyed CVs (${heldOut} held out): ${Object.entries(groups)
      .map(([g, n]) => `${g} ${n}`)
      .join(", ")}`,
  );
  for (const [version, r] of Object.entries(report)) {
    console.log(`\n${version} (${r.cvs} CVs)`);
    console.log(`  all fields            ${pct(r.overall)}`);
    console.log(`  tuned-on CVs          ${pct(r.tuned)}`);
    console.log(`  held-out CVs          ${pct(r.heldOut)}`);
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
    if (r.repeat) {
      const flips = Object.values(r.repeat.flipped).flat().length;
      const reworded = Object.values(r.repeat.reworded).flat().length;
      console.log(`  two runs over ${r.repeat.cvs} CVs: ${pct(r.repeat.run1)} then ${pct(r.repeat.run2)}`);
      console.log(`    ${flips} of ${r.repeat.run1.total} scored fields changed between right and wrong`);
      console.log(`    ${reworded} of ${r.repeat.factFields} facts fields were not identical`);
      for (const [id, fields] of Object.entries(r.repeat.flipped))
        console.log(`    ⇄ ${id}: ${fields.join(", ")}`);
      for (const [id, fields] of Object.entries(r.repeat.wrong)) {
        for (const [field, problems] of Object.entries(fields))
          console.log(`    ✗ second run, ${id} ${field}: ${problems.join("; ")}`);
      }
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
    "A _held out_ CV's key was drafted before the prompt was ever run on it.",
    "",
  ];
  for (const key of keys) {
    const e = key.expected;
    out.push(
      `## ${key.id} (${key.group}${key.heldOut ? ", held out" : ""})`,
      "",
      `PDF: ${isSynthetic(key.source) ? `packages/eval/${relativeToPkg(cvPdfPath(key))} (synthetic)` : datasetCvUrl(key.source)}`,
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

/** The profile set as it stands: per group, how many CVs of each kind, and how many have a profile at
 *  the version the eval reads. */
function list(cvs: CvEntry[], keys: CvKey[]): void {
  const extracted = (cv: CvEntry) => {
    const file = join(versionDir(PROFILE_SET_VERSION), `${cv.id}.json`);
    if (!existsSync(file)) return false;
    const profile = JSON.parse(readFileSync(file, "utf8")) as StructuredProfile;
    return profileExtractVersion(profile) === PROFILE_SET_VERSION;
  };
  console.log(`group                 CVs  dataset  synthetic  v${PROFILE_SET_VERSION}  keyed  held out`);
  for (const group of [...CV_GROUPS, "all"] as const) {
    const of = cvs.filter((cv) => group === "all" || cv.group === group);
    const keyed = keys.filter((key) => of.some((cv) => cv.id === key.id));
    const synthetic = of.filter((cv) => isSynthetic(cv.source)).length;
    console.log(
      [
        group.padEnd(21),
        String(of.length).padStart(3),
        String(of.length - synthetic).padStart(8),
        String(synthetic).padStart(10),
        String(of.filter(extracted).length).padStart(3),
        String(keyed.length).padStart(6),
        String(keyed.filter((key) => key.heldOut).length).padStart(9),
      ].join(" "),
    );
  }
}

await runScript("cv-extract", async () => {
  const cvs = loadCvRegistry();
  const keys = loadCvKeys(KEYS, cvs);
  const command = process.argv[2];
  if (command === "fetch") await fetchCvs(cvs);
  else if (command === "run") await run(cvs, keys);
  else if (command === "score") score(keys);
  else if (command === "review") review(keys);
  else if (command === "list") list(cvs, keys);
  else {
    console.error(
      "Usage: cv-extract fetch | run [--only <id,id>] [--force] [--repeat] | score | review | list",
    );
    process.exitCode = 1;
  }
});
