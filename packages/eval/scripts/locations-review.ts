/**
 * Render the location golden set as a review sheet for the owner: every pair with its context and the
 * expected answer spelled out (place name, region, country, GeoNames link; remote countries), grouped by
 * category, so a wrong label is easy to spot. Corrections go into data/locations-golden.jsonl. Like the
 * other label review sheets it is a regenerable aid, written under the gitignored data/reviews/.
 *
 *   pnpm --filter @opusfinder/eval run locations:review   (writes data/reviews/locations-golden.md)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runScript } from "@opusfinder/shared/script";

import { loadGolden, type GoldenEntry } from "../src/locations-golden";
import { PKG_ROOT, relativeToPkg } from "../src/runner";

const GOLDEN = join(PKG_ROOT, "data", "locations-golden.jsonl");
const SHEET = join(PKG_ROOT, "data", "reviews", "locations-golden.md");

await runScript("locations:review", () => {
  const golden = loadGolden(GOLDEN);
  const byCategory = new Map<string, GoldenEntry[]>();
  for (const e of golden) byCategory.set(e.category, [...(byCategory.get(e.category) ?? []), e]);

  const out = [
    "# Location golden set: review sheet",
    "",
    `${golden.length} pairs, ${golden.filter((e) => e.expected).length} labeled. For each pair, check the expected`,
    "answer against the text and the company's other strings; fix a wrong one in `locations-golden.jsonl`.",
    "",
  ];
  for (const [category, entries] of [...byCategory].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(
      `## ${category} (${entries.length})`,
      "",
      "| id | company | text | expected | note |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const e of entries) {
      out.push(
        `| ${e.id} | ${cell(e.company.slug)} | ${cell(JSON.stringify(e.raw))}${contextHint(e)} | ${expected(e)} | ${cell(e.expected?.note ?? "")} |`,
      );
    }
    out.push("");
  }
  mkdirSync(join(PKG_ROOT, "data", "reviews"), { recursive: true });
  writeFileSync(SHEET, `${out.join("\n")}\n`);
  console.log(`review sheet: ${relativeToPkg(SHEET)}`);
});

function expected(e: GoldenEntry): string {
  if (!e.expected) return "_not labeled_";
  const places = e.expected.places.map(
    (p) =>
      `[${cell([p.name, p.kind === "city" ? p.region : null, p.country].filter(Boolean).join(", "))}](https://www.geonames.org/${p.geonamesId}) (${p.kind})`,
  );
  const remote =
    e.expected.remoteCountries.length > 0
      ? [`remote: ${e.expected.remoteCountries.join(", ")}`]
      : [];
  return [...places, ...remote].join("<br>") || "no place";
}

/** The first few of the company's other strings, so a bare name can be judged in context. */
function contextHint(e: GoldenEntry): string {
  if (e.otherStrings.length === 0) return "";
  const shown = e.otherStrings.slice(0, 4).map((s) => JSON.stringify(s));
  return `<br><sub>also: ${cell(shown.join(", "))}${e.otherStrings.length > 4 ? ", …" : ""}</sub>`;
}

/** Escape a value for a Markdown table cell. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}
