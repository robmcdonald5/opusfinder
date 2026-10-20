/**
 * Deterministic spelling tolerance for the GeoNames check, on normalized names (`normalizePlaceName`).
 * Each rule only widens how a name is read; none moves a lookup outside the scope the check would use
 * anyway (the named region, else the country), so a tolerance can't put a city in another state.
 */

/** Words that only say what kind of first-level region a name is. GeoNames writes "Ogun State", "Riyadh
 *  Region" and "Haifa"; postings write "Ogun", "Riyadh Province" and "Haifa District". */
const ADMIN_WORDS: ReadonlySet<string> = new Set([
  "autonomous",
  "bundesland",
  "canton",
  "county",
  "department",
  "departamento",
  "departement",
  "district",
  "division",
  "emirate",
  "estado",
  "federal",
  "freistaat",
  "fylke",
  "governorate",
  "gouvernorat",
  "judet",
  "judetul",
  "kanton",
  "krai",
  "kray",
  "lan",
  "megye",
  "metropolitan",
  "oblast",
  "oblys",
  "oblysy",
  "oblisi",
  "prefecture",
  "province",
  "provincia",
  "provincie",
  "provinsi",
  "provinz",
  "regiao",
  "region",
  "regione",
  "republic",
  "state",
  "territory",
  "voivodeship",
  "wojewodztwo",
  // Romanized suffixes: "Gyeonggi-do", "Tokyo-to", "Osaka-fu", "Aichi-ken", "Shanghai Shi", "Guangdong Sheng".
  "do",
  "to",
  "fu",
  "ken",
  "shi",
  "sheng",
]);

/** Words joining a leading admin word to the name: "State of Mexico", "Provincia de Buenos Aires". */
const CONNECTORS: ReadonlySet<string> = new Set(["of", "de", "del", "di", "do", "da", "du", "des"]);

/**
 * A region name without the words that only say it is a region: "ogun state" → "ogun", "state of
 * mexico" → "mexico", "federal territory of kuala lumpur" → "kuala lumpur", "gyeonggi do" → "gyeonggi".
 * A name made of nothing else ("capital region") stays whole.
 */
export function regionCore(norm: string): string {
  const words = norm.split(" ").filter(Boolean);
  let start = 0;
  let end = words.length;
  while (start < end && ADMIN_WORDS.has(words[start]!)) {
    start++;
    if (start < end && CONNECTORS.has(words[start]!)) start++;
  }
  while (end > start && ADMIN_WORDS.has(words[end - 1]!)) end--;
  return start < end ? words.slice(start, end).join(" ") : norm;
}

/** Abbreviations postings and GeoNames spell either way: "St. Joseph" is GeoNames' "Saint Joseph", "St.
 *  Gallen" its "Saint Gallen"; "St. Louis" is the other way round. */
const LONG_FORMS: Readonly<Record<string, string>> = {
  st: "saint",
  ste: "sainte",
  mt: "mount",
  ft: "fort",
};
const SHORT_FORMS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(LONG_FORMS).map(([short, long]) => [long, short]),
);

/** The other spellings of a name under {@link LONG_FORMS}: every abbreviation written out, and every long
 *  form abbreviated. Empty when the name has none. */
export function nameVariants(norm: string): string[] {
  const words = norm.split(" ");
  const out = new Set([
    words.map((w) => LONG_FORMS[w] ?? w).join(" "),
    words.map((w) => SHORT_FORMS[w] ?? w).join(" "),
  ]);
  out.delete(norm);
  return [...out];
}

/** Parts of a compound name that are no place on their own. */
const NOT_A_PART: ReadonlySet<string> = new Set([
  "al",
  "bad",
  "ciudad",
  "de",
  "del",
  "east",
  "el",
  "fort",
  "great",
  "la",
  "le",
  "les",
  "little",
  "lower",
  "mount",
  "new",
  "north",
  "notre",
  "nueva",
  "nuevo",
  "old",
  "port",
  "puerto",
  "saint",
  "sainte",
  "san",
  "sankt",
  "santa",
  "santo",
  "sao",
  "south",
  "st",
  "ste",
  "upper",
  "villa",
  "west",
]);

/**
 * The first and last parts of a hyphenated compound, normalized, for a merged municipality or a
 * town-plus-district GeoNames lists by one part ("Wals-Siezenheim" → Wals, "Rapperswil-Jona" →
 * Rapperswil, "Parsippany-Troy Hills" → Parsippany). Parts that are no place alone ("Saint", "San",
 * "Bad") or shorter than three letters are left out. The check tries them only inside a region it knows.
 */
export function compoundParts(name: string, normalize: (s: string) => string): string[] {
  const parts = name.split(/\s*[-‐‑–—]\s*/).filter(Boolean);
  if (parts.length < 2) return [];
  const out: string[] = [];
  for (const part of [parts[0]!, parts[parts.length - 1]!]) {
    const norm = normalize(part);
    if (norm.length >= 3 && !NOT_A_PART.has(norm) && !out.includes(norm)) out.push(norm);
  }
  return out;
}
