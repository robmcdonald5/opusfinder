/**
 * The world regions and blocs a job can be limited to ("Remote - Europe", "NAMER", "Home based - EMEA"),
 * each as the ISO 3166-1 alpha-2 codes it covers. The normalizer names areas from {@link AREA_NAMES}; the
 * check expands them into the row's remote countries, so the location rule treats "Remote - Europe" like a
 * list of European countries. An area outside the list is not guessed at: the check keeps it as unmatched
 * and the rule treats its string as unresolved.
 *
 * Continents and their parts are the UN Statistics Division's M49 regions
 * (https://unstats.un.org/unsd/methodology/m49/), plus the two codes M49 leaves out that GeoNames has:
 * Taiwan (TW, Eastern Asia) and Kosovo (XK, Southern Europe). The business blocs (EMEA, APAC, Middle East,
 * CIS, MENA) have no standard; each is defined below, from M49 parts where it can be. Picked from the area
 * labels that production location strings use; vaguer ones (Western Europe, whose M49 meaning leaves out
 * the UK and Ireland that postings mean) are left out on purpose.
 */
import { normalizePlaceName } from "@opusfinder/shared";

const codes = (list: string) => list.split(" ");
const union = (...lists: string[][]) => [...new Set(lists.flat())];

// M49 parts.
const NORTHERN_AFRICA = codes("DZ EG LY MA SD TN EH");
const SUB_SAHARAN_AFRICA = codes(
  // Eastern, Middle, Southern, Western Africa
  "IO BI KM DJ ER ET TF KE MG MW MU YT MZ RE RW SC SO SS UG TZ ZM ZW " +
    "AO CM CF TD CG CD GQ GA ST " +
    "BW SZ LS NA ZA " +
    "BJ BF CV CI GM GH GN GW LR ML MR NE NG SH SN SL TG",
);
const CARIBBEAN = codes(
  "AI AG AW BS BB BQ VG KY CU CW DM DO GD GP HT JM MQ MS PR BL KN LC MF VC SX TT TC VI",
);
const CENTRAL_AMERICA = codes("BZ CR SV GT HN MX NI PA");
const SOUTH_AMERICA = codes("AR BO BV BR CL CO EC FK GF GY PY PE GS SR UY VE");
const NORTHERN_AMERICA = codes("BM CA GL PM US");
const CENTRAL_ASIA = codes("KZ KG TJ TM UZ");
const EASTERN_ASIA = codes("CN HK MO KP JP MN KR TW");
const SOUTH_EASTERN_ASIA = codes("BN KH ID LA MY MM PH SG TH TL VN");
const SOUTHERN_ASIA = codes("AF BD BT IN IR MV NP PK LK");
const WESTERN_ASIA = codes("AM AZ BH CY GE IQ IL JO KW LB OM QA SA PS SY TR AE YE");
const EASTERN_EUROPE = codes("BY BG CZ HU PL MD RO RU SK UA");
const NORTHERN_EUROPE = codes("AX DK EE FO FI GG IS IE IM JE LV LT NO SJ SE GB");
const SOUTHERN_EUROPE = codes("AL AD BA HR GI GR VA IT MT ME MK PT SM RS SI ES XK");
const WESTERN_EUROPE = codes("AT BE FR DE LI LU MC NL CH");
const OCEANIA = codes(
  // Australia and New Zealand, Melanesia, Micronesia, Polynesia
  "AU CX CC HM NZ NF FJ NC PG SB VU GU KI MH FM NR MP PW UM AS CK PF NU PN WS TK TO TV WF",
);

const US = ["US"];
const AFRICA = union(NORTHERN_AFRICA, SUB_SAHARAN_AFRICA);
// Plus Cyprus: an EU member that M49 files under Western Asia, and that postings mean by Europe.
const EUROPE = union(EASTERN_EUROPE, NORTHERN_EUROPE, SOUTHERN_EUROPE, WESTERN_EUROPE, ["CY"]);
const ASIA = union(CENTRAL_ASIA, EASTERN_ASIA, SOUTH_EASTERN_ASIA, SOUTHERN_ASIA, WESTERN_ASIA);

/** Each area by its canonical name: the name the prompt lists and the normalizer answers with. */
export const AREAS = {
  Africa: AFRICA,
  // M49 Americas: Latin America and the Caribbean + Northern America.
  Americas: union(CARIBBEAN, CENTRAL_AMERICA, SOUTH_AMERICA, NORTHERN_AMERICA),
  // Asia-Pacific as postings use it: East, South-East and South Asia (but Iran, which they file under
  // EMEA) and Oceania. Central and Western Asia are not in it.
  APAC: union(
    EASTERN_ASIA,
    SOUTH_EASTERN_ASIA,
    SOUTHERN_ASIA.filter((c) => c !== "IR"),
    OCEANIA,
  ),
  Asia: ASIA,
  // The Benelux Union.
  Benelux: codes("BE LU NL"),
  "Central America": CENTRAL_AMERICA,
  // The former Soviet republics but the Baltic states: the region postings mean by CIS, wider than the
  // Commonwealth's current membership.
  CIS: codes("AM AZ BY GE KZ KG MD RU TJ TM UA UZ"),
  DACH: codes("DE AT CH"),
  "Eastern Europe": EASTERN_EUROPE,
  // Europe, the Middle East and Africa: M49 Europe, Western Asia and Africa, plus Iran.
  EMEA: union(EUROPE, WESTERN_ASIA, ["IR"], AFRICA),
  Europe: EUROPE,
  // The 27 member states since 1 February 2020 (https://european-union.europa.eu/principles-countries-history/eu-countries_en).
  "European Union": codes(
    "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE",
  ),
  // The Iberian Peninsula's countries and territory.
  Iberia: codes("ES PT AD GI"),
  // M49 Latin America and the Caribbean.
  "Latin America": union(CARIBBEAN, CENTRAL_AMERICA, SOUTH_AMERICA),
  // The Gulf states, the Levant, Iraq, Iran, Türkiye, Cyprus, Yemen and Egypt.
  "Middle East": codes("AE BH CY EG IL IQ IR JO KW LB OM PS QA SA SY TR YE"),
  // The Nordic Council's countries and autonomous territories.
  Nordics: codes("DK FI IS NO SE AX FO GL"),
  // M49 Northern America.
  "North America": NORTHERN_AMERICA,
  Oceania: OCEANIA,
  "South America": SOUTH_AMERICA,
  // M49 parts.
  "East Asia": EASTERN_ASIA,
  "Southeast Asia": SOUTH_EASTERN_ASIA,
  "South Asia": SOUTHERN_ASIA,
  "Northern Europe": NORTHERN_EUROPE,
  "Southern Europe": SOUTHERN_EUROPE,
  // The Middle East (above) and M49 Northern Africa.
  MENA: codes("AE BH CY EG IL IQ IR JO KW LB OM PS QA SA SY TR YE DZ LY MA SD TN EH"),
  // Regions of the United States: two of the Census Bureau's four (Northeast, Midwest; "South" and "West"
  // alone mean too many things), two of its divisions (New England, Mid-Atlantic) and the labels postings
  // use with the US named. A remote role limited to one is open to the United States: the rule checks
  // countries, not parts of one.
  "US Northeast": US,
  "US Midwest": US,
  "US Southeast": US,
  "US Southwest": US,
  "US West Coast": US,
  "US East Coast": US,
  "US Pacific Northwest": US,
  "New England": US,
  "Mid-Atlantic": US,
} as const satisfies Record<string, readonly string[]>;

export type AreaName = keyof typeof AREAS;

export const AREA_NAMES = Object.keys(AREAS) as AreaName[];

/** Other spellings postings use, so a reply that copies the text's own label still expands. */
const ALIASES: Record<string, AreaName> = {
  amer: "Americas",
  "asia pacific": "APAC",
  apj: "APAC",
  eu: "European Union",
  latam: "Latin America",
  "middle east and north africa": "MENA",
  "middle east north africa": "MENA",
  midwest: "US Midwest",
  namer: "North America",
  "northeast asia": "East Asia",
  "south east asia": "Southeast Asia",
  noram: "North America",
  nordic: "Nordics",
  "nordic countries": "Nordics",
};

/** Labels that set no limit at all. The prompt leaves them out; a reply that names one anyway limits
 *  nothing, rather than counting as an area off the list. */
const NO_LIMIT: ReadonlySet<string> = new Set(["anywhere", "global", "international", "worldwide"]);

const BY_KEY = new Map<string, AreaName>([
  ...AREA_NAMES.map((name): [string, AreaName] => [normalizePlaceName(name), name]),
  ...Object.entries(ALIASES),
]);

/** The list's name for an area label, by its canonical name or an alias ("LATAM" → "Latin America");
 *  "no-limit" for a label that sets none ("Global"); null when the label isn't an area on the list. */
export function readArea(label: string): AreaName | "no-limit" | null {
  const key = normalizePlaceName(label);
  if (NO_LIMIT.has(key)) return "no-limit";
  return BY_KEY.get(key) ?? null;
}

/** The countries an area label covers: none for a label that sets no limit, null when it isn't on the
 *  list. */
export function areaCountries(label: string): readonly string[] | null {
  const area = readArea(label);
  if (area === null) return null;
  return area === "no-limit" ? [] : AREAS[area];
}
