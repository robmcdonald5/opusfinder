import { describe, expect, it } from "vitest";

import { companySlug } from "@opusfinder/shared";
import { rejectionOf } from "@test/rejection";

import { smartRecruitersAdapter } from "./smartrecruiters";
import type { SourceContext } from "./types";

// Leaf pure-unit for the SmartRecruiters list-item normalizer (`mapItem`). Load-bearing contract:
// the list item carries NO description and NO public apply URL, so `mapItem` must still emit a
// FULLY-VALID job — reconstructed applyUrl + descriptionText:"" — which is exactly what lets a later
// hydrate failure stay non-fatal. The traps locked here: `remote` is STRICT (only structured
// location.remote===true; "hybrid" is a distinct signal → false), company/id casing is PRESERVED
// (SmartRecruiters IDs are case-sensitive), the id is trimmed for BOTH externalId and the URL, and an
// unparseable/absent releasedDate falls back to postedAt:null rather than an Invalid Date.

const mapItem = smartRecruitersAdapter.mapItem;

// Frozen, branded context — a case-mixed slug to prove casing survives normalization.
const CTX: SourceContext = Object.freeze({
  slug: companySlug("SmartRecruitersInc"),
  rawSlug: "SmartRecruitersInc",
});

// One realistic raw list item (the four fields the list endpoint actually returns: id, name,
// location, releasedDate). Frozen so the same bytes feed every assertion.
const RAW = Object.freeze({
  id: "743999874523456",
  name: "Senior Backend Engineer",
  releasedDate: "2026-06-01T09:30:00.000Z",
  location: Object.freeze({
    city: "Berlin",
    region: "Berlin",
    country: "Germany",
    remote: false,
  }),
});

describe("smartRecruitersAdapter.mapItem — happy path", () => {
  it("maps a list item field-by-field into a fully-valid (pre-hydrate) job", () => {
    const job = mapItem(RAW, CTX);

    expect(job).not.toBeNull();
    expect(job?.source).toBe("smartrecruiters");
    expect(job?.externalId).toBe("743999874523456");
    expect(job?.title).toBe("Senior Backend Engineer");
    expect(job?.companySlug).toBe("SmartRecruitersInc");
    expect(job?.locations).toEqual(["Berlin, Berlin, Germany"]);
    expect(job?.remote).toBe(false);
    // Empty here on purpose — hydrate fills it from the jobAd sections.
    expect(job?.descriptionText).toBe("");
    // Reconstructed from the public pattern; hydrate overwrites with the real applyUrl.
    expect(job?.applyUrl).toBe(
      "https://jobs.smartrecruiters.com/SmartRecruitersInc/743999874523456",
    );
    expect(job?.postedAt).toEqual(new Date("2026-06-01T09:30:00.000Z"));
    // The raw source object is NOT carried (jobs.raw isn't stored).
    expect(job).not.toHaveProperty("raw");
  });

  it("keeps the title verbatim and preserves company slug casing (no lowercasing)", () => {
    const job = mapItem({ id: "1", name: "iOS Engineer (Remote, EMEA)" }, CTX);

    expect(job?.title).toBe("iOS Engineer (Remote, EMEA)");
    expect(job?.companySlug).toBe("SmartRecruitersInc");
  });

  it("passes a unicode title through unmangled", () => {
    const job = mapItem({ id: "1", name: "Développeur Sénior — Données" }, CTX);

    expect(job?.title).toBe("Développeur Sénior — Données");
  });

  it("trims the id for both externalId and the reconstructed applyUrl", () => {
    const job = mapItem({ id: "  POSTING-42  ", name: "Dev" }, CTX);

    expect(job?.externalId).toBe("POSTING-42");
    expect(job?.applyUrl).toBe("https://jobs.smartrecruiters.com/SmartRecruitersInc/POSTING-42");
  });
});

describe("smartRecruitersAdapter.mapItem — remote flag (strict structured signal)", () => {
  it.each([
    ["location.remote === true", { remote: true }, true],
    ["location.remote === false", { remote: false }, false],
    ["remote key omitted", {}, false],
    ['remote is the string "true", not the boolean', { remote: "true" }, false],
    ["remote is 1, not the boolean true", { remote: 1 }, false],
    ["hybrid:true is a DISTINCT signal → not remote", { hybrid: true }, false],
  ])("%s → remote=%s", (_label, location, expected) => {
    const job = mapItem({ id: "1", name: "Dev", location }, CTX);
    expect(job?.remote).toBe(expected);
  });

  it.each([
    ["location is a plain string", "Berlin"],
    ["location is null", null],
    ["location is omitted", undefined],
  ])("non-object location (%s) → remote=false", (_label, location) => {
    const job = mapItem({ id: "1", name: "Dev", location }, CTX);
    expect(job?.remote).toBe(false);
  });
});

describe("smartRecruitersAdapter.mapItem — location extraction", () => {
  it.each([
    [
      "fullLocation preferred over composed parts",
      { fullLocation: "Remote - Germany", city: "Berlin", country: "Germany" },
      ["Remote - Germany"],
    ],
    ["fullLocation is trimmed", { fullLocation: "  San Francisco, CA  " }, ["San Francisco, CA"]],
    [
      "blank fullLocation falls back to composed parts",
      { fullLocation: "   ", city: "Paris", country: "France" },
      ["Paris, France"],
    ],
    [
      "non-string fullLocation is ignored, composes from parts",
      { fullLocation: 42, city: "Paris", country: "France" },
      ["Paris, France"],
    ],
    [
      "composes city/region/country in order",
      { city: "Austin", region: "TX", country: "USA" },
      ["Austin, TX, USA"],
    ],
    [
      "drops blank and non-string parts",
      { city: "Tokyo", region: "", country: null },
      ["Tokyo"],
    ],
    ["no usable parts → empty array", {}, []],
  ])("%s", (_label, location, expected) => {
    const job = mapItem({ id: "1", name: "Dev", location }, CTX);
    expect(job?.locations).toEqual(expected);
  });

  it.each([
    ["location is a string", "Berlin"],
    ["location is null", null],
    ["location is omitted", undefined],
  ])("non-object location (%s) → empty locations", (_label, location) => {
    const job = mapItem({ id: "1", name: "Dev", location }, CTX);
    expect(job?.locations).toEqual([]);
  });
});

describe("smartRecruitersAdapter.mapItem — postedAt fallback", () => {
  it("parses a valid releasedDate into a Date", () => {
    const job = mapItem({ id: "1", name: "Dev", releasedDate: "2026-01-15T00:00:00.000Z" }, CTX);
    expect(job?.postedAt).toEqual(new Date("2026-01-15T00:00:00.000Z"));
  });

  it.each([
    ["releasedDate omitted", undefined],
    ["releasedDate is an empty string", ""],
    ["releasedDate is unparseable", "not-a-date"],
    ["releasedDate is a number, not a string", 1717233000000],
  ])("postedAt is null when %s", (_label, releasedDate) => {
    const job = mapItem({ id: "1", name: "Dev", releasedDate }, CTX);
    expect(job?.postedAt).toBeNull();
  });
});

describe("smartRecruitersAdapter.mapItem — skips malformed items (returns null, never throws)", () => {
  it.each([
    ["raw is null", null],
    ["raw is a string", "nope"],
    ["raw is a number", 42],
    ["id is missing", { name: "Dev" }],
    ["id is a number", { id: 123, name: "Dev" }],
    ["id is an empty string", { id: "", name: "Dev" }],
    ["id is whitespace only", { id: "   ", name: "Dev" }],
    ["name is missing", { id: "X1" }],
    ["name is a number", { id: "X1", name: 5 }],
  ])("returns null when %s", (_label, raw) => {
    expect(mapItem(raw as unknown, CTX)).toBeNull();
  });

  // interior-whitespace id → skip (null), never throw — mapItem contract; regression for the jobId throw.
  it("skips an interior-whitespace id without throwing", () => {
    expect(() => mapItem({ ...RAW, id: "ab cd" }, CTX)).not.toThrow();
    expect(mapItem({ ...RAW, id: "ab cd" }, CTX)).toBeNull();
  });
});

describe("smartRecruitersAdapter.hydrate — content, or a throw (never an empty patch)", () => {
  // hydrate is called by runAdapter with the resilient fetchJson; here a stub returns the parsed detail.
  const hydrate = smartRecruitersAdapter.hydrate!;
  const job = mapItem(RAW, CTX)!;
  const run = (detail: unknown) => hydrate(job, RAW, CTX, () => Promise.resolve(detail));

  it("patches the description (fixed section order), the real applyUrl and remote — and no raw", async () => {
    const patch = await run({
      applyUrl: "https://jobs.smartrecruiters.com/oneclick-ui/apply/743999874523456",
      location: { remote: true },
      jobAd: {
        sections: {
          // Deliberately out of SECTION_ORDER: the output order must not follow the key order.
          qualifications: { text: "<p>Go &amp; SQL</p>" },
          jobDescription: { text: "<p>Build APIs</p>" },
        },
      },
    });
    expect(patch).toEqual({
      descriptionText: "Build APIs\n\nGo & SQL",
      applyUrl: "https://jobs.smartrecruiters.com/oneclick-ui/apply/743999874523456",
      remote: true,
    });
    // The detail JSON is NOT kept on the job (jobs.raw isn't stored; it pinned every detail in memory).
    expect(patch).not.toHaveProperty("raw");
  });

  it("a detail WITH sections that are all blank is real (empty) content, not a failure", async () => {
    expect(await run({ jobAd: { sections: {} } })).toEqual({ descriptionText: "" });
  });

  // No jobAd.sections ⇒ no content: THROW, so runAdapter flags the listed job contentMissing and
  // upsertJobs keeps the stored posting. Returning a patch (the old `{}` / `descriptionText: ""`) would
  // "succeed" and write mapItem's placeholder "" over the stored description, NULLing its embedding.
  it.each([
    ["SR's 200 'Posting not available' object", { message: "Posting not available" }],
    ["an object whose jobAd has no sections", { jobAd: { title: "x" }, applyUrl: "https://x/1" }],
    ["JSON null (an edge/maintenance body)", null],
    ["a JSON string", "maintenance"],
  ])("throws on %s", async (_label, detail) => {
    const err = await rejectionOf(run(detail));
    expect(err.message).toBe('SmartRecruiters detail for "743999874523456" has no jobAd.sections');
  });
});
