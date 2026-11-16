/**
 * Reading the two public-sector feeds into postings shaped like production's: one title, one plain-text
 * description, raw location strings, and for each location what the feed's own structured fields say
 * it is. No model reads a location here: the structured fields become the answer production's GeoNames
 * check takes, so a public posting's places are resolved by the same check as an ATS posting's.
 */
import type { LocationAnswerValue } from "@opusfinder/locations";
import { isRecord } from "@opusfinder/shared";

export type PublicSource = "usajobs" | "nyc-jobs";

export interface PublicLocation {
  raw: string;
  answer: LocationAnswerValue | null;
  /** Where the feed itself puts the location, when it says. Used only if the name isn't a
   *  gazetteer city (a military base, a county): the nearest city to this point stands in. */
  coordinates?: { lat: number; lng: number };
}

export interface PublicPosting {
  source: PublicSource;
  externalId: string;
  /** The employer as the feed names it (a federal agency, a city agency). */
  employer: string;
  title: string;
  descriptionText: string;
  /** Raw location strings, each with what the feed's structured fields say it names; null when they
   *  give no usable place, which leaves the string unresolved. */
  locations: PublicLocation[];
  remote: boolean;
  applyUrl: string;
  postedAt: Date | null;
}

/** Production's plain-text rule for a description field: whitespace collapsed, ends trimmed. */
const collapse = (value: unknown): string =>
  (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim();

/** Labelled sections joined by blank lines; an empty section is left out. */
function sections(parts: [label: string | null, text: string][]): string {
  return parts
    .filter(([, text]) => text !== "")
    .map(([label, text]) => (label ? `${label}: ${text}` : text))
    .join("\n\n");
}

const answer = (
  reason: string,
  places: LocationAnswerValue["places"],
  remoteCountries: string[] = [],
): LocationAnswerValue => ({ reason, places, remoteCountries, areas: [], confidence: "high" });

/** US territories USAJOBS files as states of "United States"; production places them as countries. */
const US_TERRITORIES: Record<string, string> = {
  "Puerto Rico": "PR",
  Guam: "GU",
  "Virgin Islands": "VI",
  "American Samoa": "AS",
  "Northern Mariana Islands": "MP",
};

const USAJOBS_REMOTE = /^Anywhere in the U\.S\./;

/**
 * What a USAJOBS location names, from its structured fields. `countryCodes` maps the feed's country
 * names ("Germany") to ISO codes; a country it doesn't hold leaves the location unanswered.
 */
export function usajobsLocationAnswer(
  location: unknown,
  countryCodes: ReadonlyMap<string, string>,
): PublicLocation | null {
  const NO_ANSWER = null;
  if (!isRecord(location) || typeof location.LocationName !== "string") return null;
  const raw = location.LocationName.trim();
  if (raw === "") return null;
  if (USAJOBS_REMOTE.test(raw)) {
    return {
      raw,
      answer: answer("USAJOBS remote posting, open across the United States.", [], ["US"]),
    };
  }
  const country = typeof location.CountryCode === "string" ? location.CountryCode.trim() : "";
  const region =
    typeof location.CountrySubDivisionCode === "string"
      ? location.CountrySubDivisionCode.trim()
      : "";
  // CityName repeats the state or country after the last comma ("Aberdeen, Maryland").
  const cityField = typeof location.CityName === "string" ? location.CityName : raw;
  const city = cityField.includes(",")
    ? cityField.slice(0, cityField.lastIndexOf(",")).trim()
    : cityField.trim();
  if (city === "") return { raw, answer: NO_ANSWER };
  // The feed writes a missing point as 0, 0.
  const { Latitude: lat, Longitude: lng } = location;
  const point =
    typeof lat === "number" && typeof lng === "number" && (lat !== 0 || lng !== 0)
      ? { coordinates: { lat, lng } }
      : {};

  if (country === "United States") {
    const territory = US_TERRITORIES[region];
    if (territory) {
      return {
        raw,
        ...point,
        answer: answer("USAJOBS structured location in a US territory.", [
          { city, region: null, country: territory, kind: "city" },
        ]),
      };
    }
    if (region === "") return { raw, answer: NO_ANSWER };
    return {
      raw,
      ...point,
      answer: answer("USAJOBS structured city and state.", [
        { city, region, country: "US", kind: "city" },
      ]),
    };
  }
  const code = countryCodes.get(country.toLowerCase());
  if (!code) return { raw, answer: NO_ANSWER };
  return {
    raw,
    ...point,
    answer: answer("USAJOBS structured city and country.", [
      { city, region: null, country: code, kind: "city" },
    ]),
  };
}

/** USAJOBS timestamps carry no zone ("2026-09-01T00:00:00.0000"); they are read as UTC. */
function usajobsDate(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * One USAJOBS search result as a posting, or null when it has no id or title. The description is the
 * parts that say what the job is and who it is for (summary, duties, qualifications, education,
 * requirements); how to apply, benefits and the agency's marketing text are left out.
 */
export function usajobsPosting(
  item: unknown,
  countryCodes: ReadonlyMap<string, string>,
): PublicPosting | null {
  if (!isRecord(item) || !isRecord(item.MatchedObjectDescriptor)) return null;
  const d = item.MatchedObjectDescriptor;
  const details = isRecord(d.UserArea) && isRecord(d.UserArea.Details) ? d.UserArea.Details : {};
  const externalId = typeof item.MatchedObjectId === "string" ? item.MatchedObjectId.trim() : "";
  const title = collapse(d.PositionTitle);
  if (externalId === "" || title === "") return null;

  const list = (value: unknown): string =>
    Array.isArray(value)
      ? value
          .map(collapse)
          .filter((s) => s !== "")
          .join(" ")
      : collapse(value);
  const seen = new Set<string>();
  const locations = (Array.isArray(d.PositionLocation) ? d.PositionLocation : [])
    .map((l) => usajobsLocationAnswer(l, countryCodes))
    .filter(
      (l): l is NonNullable<typeof l> => l !== null && !seen.has(l.raw) && Boolean(seen.add(l.raw)),
    );

  return {
    source: "usajobs",
    externalId,
    employer:
      collapse(d.OrganizationName) || collapse(d.DepartmentName) || "Unknown federal agency",
    title,
    descriptionText: sections([
      [null, collapse(details.JobSummary)],
      ["Duties", list(details.MajorDuties)],
      ["Qualifications", collapse(d.QualificationSummary)],
      ["Education", collapse(details.Education)],
      [
        "Requirements",
        [collapse(details.Requirements), list(details.KeyRequirements)].filter(Boolean).join(" "),
      ],
    ]),
    locations,
    remote: details.RemoteIndicator === true || details.RemoteIndicator === "true",
    applyUrl: collapse(d.PositionURI).replace(":443/", "/"),
    postedAt: usajobsDate(d.PublicationStartDate),
  };
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** NYC's `post_until` ("22-DEC-2026") as the end of that day, UTC; null when absent or unreadable. */
export function nycPostUntil(value: unknown): Date | null {
  const m =
    typeof value === "string"
      ? /^(\d{1,2})-([A-Z]{3})-(\d{4})$/.exec(value.trim().toUpperCase())
      : null;
  const month = m ? MONTHS.indexOf(m[2] as string) : -1;
  if (!m || month < 0) return null;
  return new Date(Date.UTC(Number(m[3]), month, Number(m[1]), 23, 59, 59));
}

/** Every NYC Jobs posting is a New York City government job; the feed's location is a street address. */
export const NYC_LOCATION: PublicLocation = {
  raw: "New York, NY",
  answer: answer("NYC Jobs: a New York City government posting.", [
    { city: "New York City", region: "New York", country: "US", kind: "city" },
  ]),
};

/**
 * NYC Jobs rows as postings: one per job id (the dataset repeats a posting; the row updated last
 * wins), leaving out postings whose `post_until` is before `asOf`.
 */
export function nycPostings(rows: unknown[], asOf: Date): PublicPosting[] {
  const latest = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.job_id !== "string" || row.posting_type !== "External")
      continue;
    const until = nycPostUntil(row.post_until);
    if (until !== null && until < asOf) continue;
    const kept = latest.get(row.job_id);
    if (!kept || String(row.posting_updated ?? "") >= String(kept.posting_updated ?? "")) {
      latest.set(row.job_id, row);
    }
  }
  return [...latest.values()]
    .map((row): PublicPosting => {
      const posted = typeof row.posting_date === "string" ? new Date(`${row.posting_date}Z`) : null;
      return {
        source: "nyc-jobs",
        externalId: row.job_id as string,
        employer: collapse(row.agency) || "City of New York",
        title: collapse(row.business_title) || collapse(row.civil_service_title),
        descriptionText: sections([
          [null, collapse(row.job_description)],
          ["Minimum qualifications", collapse(row.minimum_qual_requirements)],
          ["Preferred skills", collapse(row.preferred_skills)],
          ["Hours and shift", collapse(row.hours_shift)],
          ["Additional information", collapse(row.additional_information)],
        ]),
        locations: [NYC_LOCATION],
        remote: false,
        // The dataset carries no posting URL; this is the city job site's search for the job id.
        applyUrl: `https://cityjobs.nyc.gov/jobs?q=${row.job_id as string}`,
        postedAt: posted && !Number.isNaN(posted.getTime()) ? posted : null,
      };
    })
    .filter((p) => p.title !== "");
}
