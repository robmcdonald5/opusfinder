/**
 * Turn drafted golden-set answers into labels: each draft names places the way the normalizer does
 * ({city, region, country, kind}, remoteCountries); this resolves them to GeoNames ids through the same
 * check production uses (against a local gazetteer) and writes them into data/locations-golden.jsonl as
 * `expected`. A draft whose place fails the check is listed and left unlabeled, to fix by hand.
 *
 *   pnpm --filter @opusfinder/eval run locations:label -- --drafts <drafts.jsonl> [--geonames <dir>]
 *
 * A drafts line: {"id":"g001","places":[{"city":null,"region":null,"country":"US","kind":"country"}],
 *                 "remoteCountries":[],"areas":[],"note":"optional"}
 * Areas are kept by the list's names (an alias like "LATAM" is written as "Latin America"); one that
 * isn't on the list fails the draft.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getPlaces } from "@opusfinder/db/repos";
import {
  checkAnswers,
  describeUnmatched,
  loadGazetteer,
  LocationAnswerSchema,
  readArea,
  type AreaName,
} from "@opusfinder/locations";
import { runScript } from "@opusfinder/shared/script";

import { getFlag } from "../src/cli";
import { openLocalGazetteer } from "../src/gazetteer";
import { loadGolden, type GoldenEntry } from "../src/locations-golden";
import { PKG_ROOT, relativeToPkg } from "../src/runner";

const GOLDEN = join(PKG_ROOT, "data", "locations-golden.jsonl");

await runScript("locations:label", async () => {
  const args = process.argv.slice(2);
  const draftsPath = getFlag(args, "--drafts");
  if (!draftsPath) throw new Error("--drafts <drafts.jsonl> is required.");
  const golden = loadGolden(GOLDEN);
  const byId = new Map(golden.map((e) => [e.id, e]));
  const drafts = readFileSync(draftsPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const d = JSON.parse(l) as { id: string; note?: string };
      if (!byId.has(d.id)) throw new Error(`draft ${d.id} is not in the golden set.`);
      return {
        id: d.id,
        note: d.note,
        answer: LocationAnswerSchema.parse({ reason: "", confidence: "high", areas: [], ...d }),
      };
    });

  const gazetteerDb = await openLocalGazetteer({ from: getFlag(args, "--geonames") });
  try {
    const gazetteer = await loadGazetteer(gazetteerDb.db);
    // Areas are labeled by name, not as their countries: check the rest, then read each area.
    const checked = await checkAnswers(
      gazetteerDb.db,
      gazetteer,
      drafts.map((d) => ({ ...d.answer, areas: [] })),
    );
    const places = new Map(
      (await getPlaces(gazetteerDb.db, [...new Set(checked.flatMap((c) => c.placeIds))])).map(
        (p) => [p.geonamesId, p],
      ),
    );
    let labeled = 0;
    drafts.forEach((draft, i) => {
      const c = checked[i]!;
      const areas = draft.answer.areas.map(readArea);
      const offList = draft.answer.areas.filter((_, j) => areas[j] === null);
      if (c.unmatched.length > 0 || offList.length > 0) {
        console.log(
          `  ✗ ${draft.id} ${JSON.stringify(byId.get(draft.id)!.raw)}: ${[
            ...c.unmatched.map(describeUnmatched),
            ...offList.map((a) => `${a} (not an area on the list)`),
          ].join("; ")}`,
        );
        return;
      }
      byId.get(draft.id)!.expected = {
        places: c.placeIds.map((id) => {
          const p = places.get(id)!;
          return {
            geonamesId: id,
            name: p.name,
            region: p.regionName,
            country: p.countryCode,
            kind: p.kind,
          };
        }),
        remoteCountries: c.remoteCountries,
        areas: [...new Set(areas.filter((a): a is AreaName => a !== null && a !== "no-limit"))],
        ...(draft.note ? { note: draft.note } : {}),
      };
      labeled++;
    });
    writeFileSync(GOLDEN, `${golden.map(serialize).join("\n")}\n`);
    console.log(`labeled ${labeled} of ${drafts.length} drafts → ${relativeToPkg(GOLDEN)}`);
  } finally {
    await gazetteerDb.close();
  }
});

/** One golden line; an empty `areas` is left out, as most labels have none. */
function serialize(entry: GoldenEntry): string {
  if (!entry.expected || entry.expected.areas.length > 0) return JSON.stringify(entry);
  const { areas: _none, ...expected } = entry.expected;
  return JSON.stringify({ ...entry, expected });
}
