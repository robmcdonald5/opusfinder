/**
 * Deterministic spelling tolerance for the GeoNames check, on normalized names (`normalizePlaceName`).
 * Each rule only widens how a name is read; none moves a lookup outside the scope the check would use
 * anyway (the named region, else the country), so a tolerance can't put a city in another state, and
 * where a rule could read a name two ways it reads it neither way.
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

/** The X of a city-region's name ("kyiv city", "city of zagreb" → "kyiv", "zagreb"); null for any other
 *  region. A country with one makes a bare X ambiguous between the city-region and the region around it. */
export function cityRegionCore(norm: string): string | null {
  const m = /^(.+) city$/.exec(norm) ?? /^city of (.+)$/.exec(norm);
  return m ? m[1]! : null;
}
