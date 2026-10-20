/**
 * Re-run the GeoNames check over what stored answers kept as unmatched, without the model. After
 * `places:load` adds places, or the check learns a spelling or the area list a bloc, a failed place in a
 * stored answer can pass: this moves it into the row's place ids (an area into its remote countries) and
 * leaves the rest on `unmatched`. Unknown country codes can't change, so they stay. The model's answer
 * (confidence, reason, prompt version) is kept, so a later prompt-version backfill still re-resolves the
 * row as usual.
 */
import type { Db } from "@opusfinder/db";
import {
  listUnmatchedLocationStrings,
  updateCheckedPlaces,
  type CheckedPlacesRow,
} from "@opusfinder/db/repos";
import type { UnmatchedPlace } from "@opusfinder/shared";

import { checkAnswers, loadGazetteer, type Gazetteer } from "./check";
import type { LocationAnswerValue } from "./schema";

export interface RecheckResult {
  /** Rows with something unmatched before the recheck. */
  rows: number;
  /** Rows the recheck changed. */
  changed: number;
  /** Unmatched entries that now pass, and those that still fail. */
  recovered: number;
  stillUnmatched: number;
  /** The changed rows, as they will be (or were) written. */
  updates: CheckedPlacesRow[];
}

export async function recheckLocationStrings(
  db: Db,
  opts: { gazetteer?: Gazetteer; dryRun?: boolean } = {},
): Promise<RecheckResult> {
  const rows = await listUnmatchedLocationStrings(db);
  const gazetteer = opts.gazetteer ?? (await loadGazetteer(db));
  const split = rows.map((row) => ({
    row,
    retry: row.unmatched.filter((u) => u.why !== "unknown-country"),
    keep: row.unmatched.filter((u) => u.why === "unknown-country"),
  }));
  const checked = await checkAnswers(
    db,
    gazetteer,
    split.map(({ retry }) => answerOf(retry)),
  );
  const updates: CheckedPlacesRow[] = [];
  let recovered = 0;
  let stillUnmatched = 0;
  split.forEach(({ row, retry, keep }, i) => {
    const c = checked[i]!;
    recovered += retry.length - c.unmatched.length;
    stillUnmatched += keep.length + c.unmatched.length;
    if (c.unmatched.length === retry.length) return;
    updates.push({
      ...row,
      placeIds: [...new Set([...row.placeIds, ...c.placeIds])],
      remoteCountries: [...new Set([...row.remoteCountries, ...c.remoteCountries])],
      unmatched: [...keep, ...c.unmatched],
    });
  });
  if (!opts.dryRun) await updateCheckedPlaces(db, updates);
  return { rows: rows.length, changed: updates.length, recovered, stillUnmatched, updates };
}

/** The unmatched entries as an answer the check reads: places as the model named them, areas by name. */
function answerOf(entries: UnmatchedPlace[]): LocationAnswerValue {
  return {
    reason: "",
    places: entries.flatMap((u) =>
      u.kind === "area"
        ? []
        : [{ city: u.city, region: u.region, country: u.country, kind: u.kind }],
    ),
    remoteCountries: [],
    areas: entries.flatMap((u) => (u.kind === "area" ? [u.name] : [])),
    confidence: "high",
  };
}
