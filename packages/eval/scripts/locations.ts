/**
 * Score the location normalizer against the golden set: the production prompt, schema, model and GeoNames
 * check, run over every labeled pair, with and without the company context, by exact match on the
 * checked place ids + remote countries. Run it on demand and before any prompt or model change (bump
 * PROMPT_VERSION in @opusfinder/locations with the change). Not a CI gate: the model is live.
 *
 * The check runs against a local copy of the gazetteer (PGlite, loaded from the GeoNames files), so no
 * database credential is needed. Needs the location model's provider key (see @opusfinder/locations).
 *
 *   pnpm eval:locations                               (both context modes; downloads GeoNames)
 *   pnpm eval:locations -- --geonames <dir>           (use already-downloaded GeoNames files)
 *   pnpm eval:locations -- --context with|without     (one mode only)
 *   pnpm eval:locations -- --batch                    (one provider batch per mode: half price, slower)
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildLocationRequest,
  checkAnswers,
  createLocationModel,
  describeUnmatched,
  loadGazetteer,
  parseAnswer,
  PROMPT_STRINGS,
  PROMPT_VERSION,
  type CheckedAnswer,
  type LocationAnswer,
  type LocationModel,
  type LocationRequest,
} from "@opusfinder/locations";
import { runScript } from "@opusfinder/shared/script";

import { getFlag } from "../src/cli";
import { openLocalGazetteer } from "../src/gazetteer";
import {
  answerMatches,
  loadGolden,
  scoreGolden,
  type GoldenEntry,
  type GoldenScore,
} from "../src/locations-golden";
import { PKG_ROOT, relativeToPkg } from "../src/runner";

const GOLDEN = join(PKG_ROOT, "data", "locations-golden.jsonl");
const REPORT = join(PKG_ROOT, "reports", "locations.golden.json");
const CONCURRENCY = 5;
const SHOW_FAILURES = 40;

type Mode = "with" | "without";

await runScript("eval:locations", async () => {
  const args = process.argv.slice(2);
  const contextFlag = getFlag(args, "--context");
  if (contextFlag !== undefined && contextFlag !== "with" && contextFlag !== "without") {
    throw new Error("--context must be with or without.");
  }
  const modes: Mode[] = contextFlag ? [contextFlag] : ["with", "without"];
  const golden = loadGolden(GOLDEN);
  const labeled = golden.filter((e) => e.expected);
  console.log(
    `golden set: ${golden.length} pairs, ${labeled.length} labeled (${relativeToPkg(GOLDEN)})`,
  );
  if (labeled.length === 0)
    throw new Error("No labeled pairs yet: draft and review the expected answers first.");

  const gazetteerDb = await openLocalGazetteer({ from: getFlag(args, "--geonames") });
  try {
    console.log(`local gazetteer: ${gazetteerDb.places} places`);
    const gazetteer = await loadGazetteer(gazetteerDb.db);
    const model = createLocationModel();
    const report: Record<string, unknown> = {
      promptVersion: PROMPT_VERSION,
      labeled: labeled.length,
    };
    for (const mode of modes) {
      const requests = labeled.map((e, i) => buildLocationRequest(`g${i}`, promptPair(e, mode)));
      const answers = args.includes("--batch")
        ? await viaBatch(model, requests)
        : await viaGenerate(model, requests);
      const parsed = answers.map(parseAnswer);
      const values = parsed.flatMap((p) => ("value" in p ? [p.value] : []));
      const checked = await checkAnswers(gazetteerDb.db, gazetteer, values);
      let next = 0;
      const results = labeled.map((entry, i) => {
        const p = parsed[i]!;
        if (!("value" in p))
          return {
            entry,
            correct: false,
            got: null,
            problem: "failed" in p ? p.failed : p.unanswered,
          };
        const got = checked[next++]!;
        return { entry, correct: answerMatches(entry.expected!, got), got, reason: p.value.reason };
      });
      const score = scoreGolden(results, PROMPT_STRINGS);
      printScore(mode, score);
      const failures = results.filter((r) => !r.correct);
      for (const f of failures.slice(0, SHOW_FAILURES)) {
        const expected = f.entry.expected!;
        console.log(
          `  ✗ ${f.entry.id} ${f.entry.company.slug} · ${JSON.stringify(f.entry.raw)}\n` +
            `      expected ${expected.places.map((p) => `${p.name}(${p.geonamesId})`).join(", ") || "no place"}` +
            `${expected.remoteCountries.length ? ` · remote ${expected.remoteCountries.join(",")}` : ""}` +
            `${expected.areas.length ? ` · areas ${expected.areas.join(",")}` : ""}\n` +
            `      got      ${f.got ? describeGot(f.got) : `no answer (${"problem" in f ? f.problem : ""})`}` +
            `${"reason" in f && f.reason ? ` · ${f.reason}` : ""}`,
        );
      }
      report[`context-${mode}`] = {
        score,
        failures: failures.map((f) => ({ id: f.entry.id, raw: f.entry.raw, got: f.got })),
      };
    }
    writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nreport: ${relativeToPkg(REPORT)}`);
  } finally {
    await gazetteerDb.close();
  }
});

function promptPair(entry: GoldenEntry, mode: Mode) {
  return mode === "with"
    ? {
        raw: entry.raw,
        company: {
          slug: entry.company.slug,
          source: entry.company.source,
          otherStrings: entry.otherStrings,
        },
      }
    : { raw: entry.raw };
}

async function viaGenerate(
  model: LocationModel,
  requests: LocationRequest[],
): Promise<LocationAnswer[]> {
  const out = new Array<LocationAnswer>(requests.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < requests.length) {
        const i = next++;
        out[i] = await model.generate(requests[i]!).catch(
          (err: unknown): LocationAnswer => ({
            status: "failed",
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }),
  );
  return out;
}

async function viaBatch(
  model: LocationModel,
  requests: LocationRequest[],
): Promise<LocationAnswer[]> {
  const results = await model.collectBatch(await model.submitBatch(requests));
  return requests.map(
    (r) => results.get(r.id) ?? { status: "failed", reason: "missing from the batch results" },
  );
}

function describeGot(got: CheckedAnswer): string {
  const remote = got.remoteCountries;
  return (
    `${got.placeIds.join(", ") || "no place"}` +
    `${remote.length ? ` · remote ${remote.length > 8 ? `${remote.length} countries` : remote.join(",")}` : ""}` +
    `${got.unmatched.length ? ` · unmatched ${got.unmatched.map(describeUnmatched).join("; ")}` : ""}`
  );
}

function printScore(mode: Mode, score: GoldenScore): void {
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  console.log(
    `\ncontext ${mode}: ${pct(score.accuracy)} exact (${score.correct}/${score.n}); ` +
      `${pct(score.unseen.accuracy)} on the ${score.unseen.n} pairs the prompt doesn't quote`,
  );
  for (const [category, c] of Object.entries(score.byCategory).sort()) {
    console.log(
      `  ${category.padEnd(8)} ${pct(c.correct / c.n).padStart(6)} (${c.correct}/${c.n})`,
    );
  }
}
