import { describe, expect, it } from "vitest";

import {
  NYC_LOCATION,
  nycPostings,
  nycPostUntil,
  usajobsLocationAnswer,
  usajobsPosting,
} from "./public-jobs";

const COUNTRIES = new Map([["germany", "DE"]]);

const usLocation = (name: string, state: string, extra: Record<string, unknown> = {}) => ({
  LocationName: `${name}, ${state}`,
  CountryCode: "United States",
  CountrySubDivisionCode: state,
  CityName: `${name}, ${state}`,
  Longitude: -76.1,
  Latitude: 39.5,
  ...extra,
});

describe("usajobsLocationAnswer", () => {
  it("reads a US city and state from the structured fields, keeping the feed's point", () => {
    expect(usajobsLocationAnswer(usLocation("Aberdeen", "Maryland"), COUNTRIES)).toEqual({
      raw: "Aberdeen, Maryland",
      coordinates: { lat: 39.5, lng: -76.1 },
      answer: expect.objectContaining({
        places: [{ city: "Aberdeen", region: "Maryland", country: "US", kind: "city" }],
        remoteCountries: [],
        confidence: "high",
      }),
    });
  });

  it("keeps a comma inside the city name", () => {
    const location = usLocation("Naval Base, Norfolk", "Virginia");
    expect(usajobsLocationAnswer(location, COUNTRIES)?.answer?.places[0]).toMatchObject({
      city: "Naval Base, Norfolk",
      region: "Virginia",
    });
  });

  it("places a US territory as its own country, as production does", () => {
    const location = usLocation("San Juan", "Puerto Rico");
    expect(usajobsLocationAnswer(location, COUNTRIES)?.answer?.places).toEqual([
      { city: "San Juan", region: null, country: "PR", kind: "city" },
    ]);
  });

  it("reads a city abroad when the country is known, and gives no answer when it isn't", () => {
    const abroad = (country: string) => ({
      LocationName: `Ramstein, ${country}`,
      CountryCode: country,
      CountrySubDivisionCode: null,
      CityName: `Ramstein, ${country}`,
      Longitude: 7.5,
      Latitude: 49.4,
    });
    expect(usajobsLocationAnswer(abroad("Germany"), COUNTRIES)?.answer?.places).toEqual([
      { city: "Ramstein", region: null, country: "DE", kind: "city" },
    ]);
    expect(usajobsLocationAnswer(abroad("Atlantis"), COUNTRIES)).toEqual({
      raw: "Ramstein, Atlantis",
      answer: null,
    });
  });

  it("reads a country the feed writes with a comma, or under a name the gazetteer lacks", () => {
    const inverted = {
      LocationName: "Banjul, Gambia, The",
      CountryCode: "Gambia, The",
      CountrySubDivisionCode: null,
      CityName: "Banjul, Gambia, The",
      Longitude: -16.6,
      Latitude: 13.5,
    };
    expect(usajobsLocationAnswer(inverted, COUNTRIES)?.answer?.places).toEqual([
      { city: "Banjul", region: null, country: "GM", kind: "city" },
    ]);
    const renamed = {
      ...inverted,
      LocationName: "Rangoon, Burma",
      CountryCode: "Burma",
      CityName: "Rangoon, Burma",
    };
    expect(usajobsLocationAnswer(renamed, COUNTRIES)?.answer?.places).toEqual([
      { city: "Rangoon", region: null, country: "MM", kind: "city" },
    ]);
  });

  it("reads the remote placeholder as remote across the United States, with no place", () => {
    const remote = {
      LocationName: "Anywhere in the U.S. (remote job), United States",
      CountryCode: "United States",
      CountrySubDivisionCode: null,
      CityName: "Anywhere in the U.S. (remote job), United States",
      Longitude: 0,
      Latitude: 0,
    };
    expect(usajobsLocationAnswer(remote, COUNTRIES)).toEqual({
      raw: remote.LocationName,
      answer: expect.objectContaining({ places: [], remoteCountries: ["US"] }),
    });
  });

  it("drops a missing point (0, 0) and a location with no name", () => {
    const noPoint = usLocation("Aberdeen", "Maryland", { Latitude: 0, Longitude: 0 });
    expect(usajobsLocationAnswer(noPoint, COUNTRIES)).not.toHaveProperty("coordinates");
    expect(usajobsLocationAnswer({ CityName: "x" }, COUNTRIES)).toBeNull();
  });
});

describe("usajobsPosting", () => {
  const item = {
    MatchedObjectId: "721962100",
    MatchedObjectDescriptor: {
      PositionTitle: "  Registered  Nurse ",
      PositionURI: "https://www.usajobs.gov:443/job/721962100",
      OrganizationName: "Veterans Health Administration",
      DepartmentName: "Department of Veterans Affairs",
      QualificationSummary: "Active RN licence.\r\nOne year of experience.",
      PublicationStartDate: "2026-09-01T00:00:00.0000",
      PositionLocation: [usLocation("Aberdeen", "Maryland"), usLocation("Aberdeen", "Maryland")],
      UserArea: {
        Details: {
          JobSummary: "Provides direct patient care.",
          MajorDuties: ["Assess patients.", "", "Administer medication."],
          Education: "",
          Requirements: "US citizenship.",
          KeyRequirements: ["Background check"],
          HowToApply: "Apply online.",
          AgencyMarketingStatement: "We serve veterans.",
          RemoteIndicator: false,
        },
      },
    },
  };

  it("builds one posting: the sections that describe the job, in plain text", () => {
    expect(usajobsPosting(item, COUNTRIES)).toMatchObject({
      source: "usajobs",
      externalId: "721962100",
      employer: "Veterans Health Administration",
      title: "Registered Nurse",
      descriptionText:
        "Provides direct patient care.\n\n" +
        "Duties: Assess patients. Administer medication.\n\n" +
        "Qualifications: Active RN licence. One year of experience.\n\n" +
        "Requirements: US citizenship. Background check",
      remote: false,
      applyUrl: "https://www.usajobs.gov/job/721962100",
      postedAt: new Date("2026-09-01T00:00:00Z"),
    });
  });

  it("lists a repeated location once", () => {
    expect(usajobsPosting(item, COUNTRIES)?.locations.map((l) => l.raw)).toEqual([
      "Aberdeen, Maryland",
    ]);
  });

  it("reads the remote flag whether the feed sends a boolean or a string", () => {
    const remote = structuredClone(item);
    (remote.MatchedObjectDescriptor.UserArea.Details as Record<string, unknown>).RemoteIndicator =
      "true";
    expect(usajobsPosting(remote, COUNTRIES)?.remote).toBe(true);
  });

  it("returns null for a result with no id or no title", () => {
    expect(usajobsPosting({ ...item, MatchedObjectId: "" }, COUNTRIES)).toBeNull();
    expect(
      usajobsPosting({ MatchedObjectId: "1", MatchedObjectDescriptor: {} }, COUNTRIES),
    ).toBeNull();
    expect(usajobsPosting("nonsense", COUNTRIES)).toBeNull();
  });
});

describe("nycPostings", () => {
  const AS_OF = new Date("2026-11-16T03:00:00Z");
  const row = (fields: Record<string, unknown> = {}) => ({
    job_id: "807877",
    agency: "HRA/DEPT OF SOCIAL SERVICES",
    posting_type: "External",
    business_title: "ELIGIBILITY WORKER",
    civil_service_title: "ELIGIBILITY SPECIALIST",
    job_description: "Determines eligibility.",
    minimum_qual_requirements: "30 semester credits.",
    preferred_skills: "Organised.",
    work_location: "375 Pearl Street",
    posting_date: "2026-10-23T00:00:00.000",
    post_until: "22-DEC-2026",
    posting_updated: "2026-10-23T00:00:00.000",
    ...fields,
  });

  it("builds a posting placed in New York City", () => {
    expect(nycPostings([row()], AS_OF)).toEqual([
      {
        source: "nyc-jobs",
        externalId: "807877",
        employer: "HRA/DEPT OF SOCIAL SERVICES",
        title: "ELIGIBILITY WORKER",
        descriptionText:
          "Determines eligibility.\n\nMinimum qualifications: 30 semester credits.\n\nPreferred skills: Organised.",
        locations: [NYC_LOCATION],
        remote: false,
        applyUrl: "https://cityjobs.nyc.gov/jobs?q=807877",
        postedAt: new Date("2026-10-23T00:00:00Z"),
      },
    ]);
  });

  it("keeps one row per job id: the one updated last", () => {
    const rows = [
      row({ business_title: "OLD", posting_updated: "2026-10-23T00:00:00.000" }),
      row({ business_title: "NEW", posting_updated: "2026-11-02T00:00:00.000" }),
    ];
    expect(nycPostings(rows, AS_OF).map((p) => p.title)).toEqual(["NEW"]);
  });

  it("leaves out internal postings and postings past their closing day, and keeps open-ended ones", () => {
    const rows = [
      row({ job_id: "1", posting_type: "Internal" }),
      row({ job_id: "2", post_until: "15-NOV-2026" }),
      row({ job_id: "3", post_until: "16-NOV-2026" }),
      row({ job_id: "4", post_until: undefined }),
    ];
    expect(nycPostings(rows, AS_OF).map((p) => p.externalId)).toEqual(["3", "4"]);
  });
});

describe("nycPostUntil", () => {
  it("reads the feed's day as the end of that day, UTC", () => {
    expect(nycPostUntil("22-DEC-2026")).toEqual(new Date("2026-12-22T23:59:59Z"));
    expect(nycPostUntil("1-jan-2027")).toEqual(new Date("2027-01-01T23:59:59Z"));
  });

  it("is null for a missing or unreadable value", () => {
    expect(nycPostUntil(undefined)).toBeNull();
    expect(nycPostUntil("Until Filled")).toBeNull();
  });
});
