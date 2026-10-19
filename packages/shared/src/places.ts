/** A `places` row's kind: a GeoNames city, first-level region (state, province, admin1) or country. */
export type PlaceKind = "city" | "region" | "country";

/** How sure the location normalizer was of its answer for one location string. */
export type LocationConfidence = "high" | "medium" | "low";

/** A place the normalizer named that the GeoNames check could not find, kept on the location_strings row
 *  (`unmatched`) so `locations:report` can list it. `why` says which part failed. */
export interface UnmatchedPlace {
  city: string | null;
  region: string | null;
  country: string;
  kind: PlaceKind;
  why: "unknown-country" | "unknown-region" | "unknown-city";
}

/** Letters that NFKD leaves whole, folded to the ASCII GeoNames uses ("Søborg" → "soborg"). */
const FOLDS: Record<string, string> = {
  ø: "o",
  æ: "ae",
  œ: "oe",
  ß: "ss",
  đ: "d",
  ð: "d",
  ł: "l",
  ı: "i",
  þ: "th",
};

/**
 * The matching key for a place name: lowercased, diacritics and punctuation dropped, whitespace collapsed
 * ("Zürich" → "zurich", "St. Louis" → "st louis", "Washington, D.C." → "washington d c"). The ONE
 * definition, used by places:load to write `places.*_norm` and by every lookup that reads them, so a
 * stored key and a query key can't drift apart.
 */
export function normalizePlaceName(name: string): string {
  const folded = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[øæœßđðłıþ]/g, (c) => FOLDS[c] ?? c);
  return folded.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
