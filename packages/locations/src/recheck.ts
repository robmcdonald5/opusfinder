/**
 * Re-run the GeoNames check over what stored answers kept as unmatched, without the model, for a change
 * to the check, the area list or `places` alone. A failed place that passes now moves into the row's place
 * ids (an area into its remote countries); the rest stays on `unmatched`, and unknown country codes can't
 * change. Only rows the current prompt version wrote are rechecked (an older answer was read under older
 * rules; the backfill re-resolves it), and a row rewritten meanwhile is left alone. The model's answer
 * (confidence, reason, prompt version) is kept.
 */
import type { Db } from "@opusfinder/db";
import {
  listUnmatchedLocationStrings,
  updateCheckedPlaces,
  type CheckedPlacesUpdate,
} from "@opusfinder/db/repos";
import type { UnmatchedPlace } from "@opusfinder/shared";

import { checkAnswers, loadGazetteer, type Gazetteer } from "./check";
import { PROMPT_VERSION } from "./prompt";
import type { LocationAnswerValue } from "./schema";

export interface RecheckResult {
  /** Rows of the current prompt version with something unmatched before the recheck. */
  rows: number;
  /** Rows the recheck changed. */
  changed: number;
  /** Changed rows actually written; the rest were rewritten by something else meanwhile (0 on a dry run). */
  written: number;
  /** Unmatched entries that now pass, and those that still fail. */
  recovered: number;
  stillUnmatched: number;
  /** The changed rows, as they will be (or were) written. */
  updates: CheckedPlacesUpdate[];
}

export async function recheckLocationStrings(
  db: Db,
  opts: { gazetteer?: Gazetteer; dryRun?: boolean } = {},
): Promise<RecheckResult> {
  const rows = await listUnmatchedLocationStrings(db, PROMPT_VERSION);
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
  const updates: CheckedPlacesUpdate[] = [];
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
      previousUnmatched: row.unmatched,
    });
  });
  const written = opts.dryRun ? 0 : await updateCheckedPlaces(db, updates);
  return {
    rows: rows.length,
    changed: updates.length,
    written,
    recovered,
    stillUnmatched,
    updates,
  };
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
