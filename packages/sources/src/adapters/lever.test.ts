import { unsafeCompanySlug } from "@opusfinder/shared";
import { describe, expect, it } from "vitest";

import { leverAdapter } from "./lever";
import type { SourceContext } from "./types";

// Leaf pure-unit for the Lever mapper (mapItem → toNormalizedJob). This is the contract that turns
// one untrusted board-API posting into a NormalizedJob, and Lever's quirks are load-bearing:
//   - the id is a UUID STRING (not numeric) and the title lives on `text` (not `title`);
//   - `createdAt` is MS-since-epoch (an integer), not an ISO string, and a missing/NaN/Infinity
//     value must yield postedAt=null rather than an Invalid Date;
//   - `workplaceType` is a STRUCTURED remote signal — only the exact spellings remote/onsite/hybrid
//     are authoritative (and override the location text); anything else infers from the location;
//   - locations prefer the multi-office `categories.allLocations`, fall back to `categories.location`,
//     and are kept WHOLE — trimmed/blank-filtered but never split, sorted, or de-duped;
//   - applyUrl prefers `applyUrl` then `hostedUrl` via a `||` chain (an EMPTY applyUrl falls through);
//   - bad-row guards return `null` (skip + count) rather than throwing, so one malformed posting
//     can't abort a whole page.
// Ctx.slug is already branded by normalizeSlug upstream (case PRESERVED — Lever slugs are
// case-sensitive); mapItem just stamps it on.
const ctx: SourceContext = Object.freeze({
  slug: unsafeCompanySlug("Acme"),
  rawSlug: "Acme",
});

// A frozen, realistic `?mode=json` posting: UUID id, ms-epoch createdAt, structured workplaceType,
// multi-office categories, and a pre-stripped plain-text `descriptionPlain`.
// createdAt 1717200000000 = 2024-06-01T00:00:00.000Z.
const RAW_JOB = Object.freeze({
  id: "a1b2c3d4-0000-4abc-8def-1234567890ab",
  text: "Senior Backend Engineer",
  hostedUrl: "https://jobs.lever.co/acme/a1b2c3d4-0000-4abc-8def-1234567890ab",
  applyUrl: "https://jobs.lever.co/acme/a1b2c3d4-0000-4abc-8def-1234567890ab/apply",
  createdAt: 1717200000000,
  workplaceType: "onsite",
  categories: Object.freeze({
    team: "Engineering",
    location: "San Francisco, CA",
    allLocations: Object.freeze(["San Francisco, CA", "New York, NY"]),
    commitment: "Full-time",
  }),
  descriptionPlain: "  We are hiring   a backend\n\nengineer.  ",
  description: "<p>We are hiring a backend engineer.</p>",
});

function mapJob(raw: unknown) {
  return leverAdapter.mapItem(raw, ctx);
}

describe("leverAdapter.mapItem", () => {
  it("maps a complete raw posting field-by-field", () => {
    const job = mapJob(RAW_JOB);

    expect(job).not.toBeNull();
    expect(job).toMatchObject({
      source: "lever",
      externalId: "a1b2c3d4-0000-4abc-8def-1234567890ab",
      title: "Senior Backend Engineer",
      companySlug: "Acme",
      locations: ["San Francisco, CA", "New York, NY"],
      remote: false,
      descriptionText: "We are hiring a backend engineer.",
      // applyUrl wins over hostedUrl when both are present.
      applyUrl: "https://jobs.lever.co/acme/a1b2c3d4-0000-4abc-8def-1234567890ab/apply",
    });
    // ms-epoch createdAt becomes a Date by exact instant.
    expect(job?.postedAt).toBeInstanceOf(Date);
    expect(job?.postedAt?.getTime()).toBe(1717200000000);
    expect(job?.postedAt?.toISOString()).toBe("2024-06-01T00:00:00.000Z");
    // raw is preserved by identity for downstream reprocessing.
    expect(job?.raw).toBe(RAW_JOB);
  });

  it("keeps the title verbatim from `text` (no casing/whitespace normalization here)", () => {
    const job = mapJob({ ...RAW_JOB, text: "  iOS & macOS DEVELOPER  " });
    expect(job?.title).toBe("  iOS & macOS DEVELOPER  ");
  });

  it("trims SURROUNDING whitespace off the id when branding externalId (jobId trims)", () => {
    // Surrounding whitespace is fine (it trims away); only INTERNAL whitespace is invalid, and
    // the id guard lets that through to jobId — see the production-gap note in this phase's report.
    const job = mapJob({ ...RAW_JOB, id: "  a1b2c3d4-0000-4abc-8def-1234567890ab  " });
    expect(job?.externalId).toBe("a1b2c3d4-0000-4abc-8def-1234567890ab");
  });

  it("preserves the slug casing supplied by ctx (Lever is case-sensitive)", () => {
    const job = leverAdapter.mapItem(RAW_JOB, {
      slug: unsafeCompanySlug("MixedCaseCo"),
      rawSlug: "MixedCaseCo",
    });
    expect(job?.companySlug).toBe("MixedCaseCo");
  });

  describe("applyUrl fallback (applyUrl || hostedUrl, else skip)", () => {
    it("prefers applyUrl when both are present", () => {
      const job = mapJob({ ...RAW_JOB, applyUrl: "https://a.example/apply", hostedUrl: "https://h.example" });
      expect(job?.applyUrl).toBe("https://a.example/apply");
    });

    it("falls back to hostedUrl when applyUrl is missing", () => {
      const { applyUrl: _omit, ...rest } = RAW_JOB;
      const job = mapJob(rest);
      expect(job?.applyUrl).toBe(RAW_JOB.hostedUrl);
    });

    it("falls back to hostedUrl when applyUrl is an EMPTY string (|| not ??)", () => {
      const job = mapJob({ ...RAW_JOB, applyUrl: "" });
      expect(job?.applyUrl).toBe(RAW_JOB.hostedUrl);
    });

    it("falls back to hostedUrl when applyUrl is a non-string", () => {
      const job = mapJob({ ...RAW_JOB, applyUrl: 123 });
      expect(job?.applyUrl).toBe(RAW_JOB.hostedUrl);
    });
  });

  describe("postedAt from ms-epoch createdAt", () => {
    it("converts a finite ms-epoch integer to a Date", () => {
      const job = mapJob({ ...RAW_JOB, createdAt: 1700000000000 });
      expect(job?.postedAt?.getTime()).toBe(1700000000000);
    });

    it("treats epoch 0 as a valid instant (not null)", () => {
      const job = mapJob({ ...RAW_JOB, createdAt: 0 });
      expect(job?.postedAt?.getTime()).toBe(0);
    });

    it.each([
      ["missing createdAt", (() => {
        const { createdAt: _c, ...rest } = RAW_JOB;
        return rest;
      })()],
      ["createdAt is an ISO string", { ...RAW_JOB, createdAt: "2024-06-01T00:00:00.000Z" }],
      ["createdAt is NaN", { ...RAW_JOB, createdAt: Number.NaN }],
      ["createdAt is Infinity", { ...RAW_JOB, createdAt: Number.POSITIVE_INFINITY }],
    ])("is null when %s", (_label, raw) => {
      expect(mapJob(raw)?.postedAt).toBeNull();
    });
  });

  describe("remote signal", () => {
    // KNOWN workplaceType values are authoritative and OVERRIDE the location text — proven in
    // BOTH directions: "remote" wins over a non-remote location, "onsite"/"hybrid" win over a
    // "Remote …" location. (Same-direction rows would pass on the location alone and prove nothing.)
    it.each([
      ["remote", "Austin, TX", true],
      ["onsite", "Remote - United States", false],
      ["hybrid", "Remote - United States", false],
    ])("workplaceType %j is authoritative over location %j → remote=%s", (workplaceType, loc, expected) => {
      const job = mapJob({
        ...RAW_JOB,
        workplaceType,
        categories: { allLocations: [loc] },
      });
      expect(job?.remote).toBe(expected);
    });

    // Any UNKNOWN/absent value (incl. wrong casing) infers from the location text via \bremote\b.
    it.each([
      ["unspecified", "Remote - United States", true],
      ["work-from-home", "Remote, EMEA", true],
      ["REMOTE", "Austin, TX", false],
      ["unspecified", "Austin, TX", false],
      ["unspecified", "Remoteville, OH", false],
    ])("unknown workplaceType %j infers from location %j → remote=%s", (workplaceType, loc, expected) => {
      const job = mapJob({ ...RAW_JOB, workplaceType, categories: { allLocations: [loc] } });
      expect(job?.remote).toBe(expected);
    });

    it("infers from location text when workplaceType is absent entirely", () => {
      const { workplaceType: _omit, ...rest } = RAW_JOB;
      const job = mapJob({ ...rest, categories: { allLocations: ["Remote - US"] } });
      expect(job?.remote).toBe(true);
    });

    it("infers from location text when workplaceType is a non-string", () => {
      const job = mapJob({ ...RAW_JOB, workplaceType: 1, categories: { allLocations: ["Remote - US"] } });
      expect(job?.remote).toBe(true);
    });
  });

  describe("location extraction (allLocations preferred, else location; kept whole)", () => {
    it("prefers categories.allLocations over categories.location", () => {
      const job = mapJob({
        ...RAW_JOB,
        categories: { location: "Boston, MA", allLocations: ["London, UK", "Berlin, DE"] },
      });
      expect(job?.locations).toEqual(["London, UK", "Berlin, DE"]);
    });

    it("trims and drops blank/non-string entries from allLocations, preserving order", () => {
      const job = mapJob({
        ...RAW_JOB,
        categories: { allLocations: ["  Berlin  ", "", "   ", 42, null, "Remote"] },
      });
      expect(job?.locations).toEqual(["Berlin", "Remote"]);
    });

    it("does NOT sort or de-duplicate (multi-office strings are kept whole)", () => {
      const job = mapJob({
        ...RAW_JOB,
        categories: { allLocations: ["Zurich, CH", "Amsterdam, NL", "Zurich, CH"] },
      });
      expect(job?.locations).toEqual(["Zurich, CH", "Amsterdam, NL", "Zurich, CH"]);
    });

    it("falls back to categories.location when allLocations has no surviving entries", () => {
      const job = mapJob({
        ...RAW_JOB,
        categories: { location: "  Seattle, WA  ", allLocations: ["", "   "] },
      });
      expect(job?.locations).toEqual(["Seattle, WA"]);
    });

    it("uses categories.location (trimmed) when allLocations is absent", () => {
      const job = mapJob({ ...RAW_JOB, categories: { location: "  Paris, FR  " } });
      expect(job?.locations).toEqual(["Paris, FR"]);
    });

    it("falls back to categories.location when allLocations is present but NOT an array", () => {
      const job = mapJob({ ...RAW_JOB, categories: { location: "Tokyo, JP", allLocations: "Tokyo, JP" } });
      expect(job?.locations).toEqual(["Tokyo, JP"]);
    });

    it.each([
      ["categories missing entirely", (() => {
        const { categories: _c, ...rest } = RAW_JOB;
        return rest;
      })()],
      ["categories is not a record", { ...RAW_JOB, categories: "Remote" }],
      ["categories has neither field", { ...RAW_JOB, categories: { team: "Eng" } }],
      ["location is whitespace-only", { ...RAW_JOB, categories: { location: "   " } }],
      ["location is a non-string", { ...RAW_JOB, categories: { location: 42 } }],
    ])("yields an empty locations array when %s", (_label, raw) => {
      expect(mapJob(raw)?.locations).toEqual([]);
    });
  });

  describe("descriptionText cleaning (plain text → collapse only)", () => {
    it("collapses internal/leading/trailing whitespace from descriptionPlain", () => {
      const job = mapJob({ ...RAW_JOB, descriptionPlain: "  Lead\tthe   platform\n\n team.  " });
      expect(job?.descriptionText).toBe("Lead the platform team.");
    });

    it("is an empty string when descriptionPlain is missing", () => {
      const { descriptionPlain: _omit, ...rest } = RAW_JOB;
      expect(mapJob(rest)?.descriptionText).toBe("");
    });

    it("is an empty string when descriptionPlain is not a string", () => {
      const job = mapJob({ ...RAW_JOB, descriptionPlain: { html: "<p>x</p>" } });
      expect(job?.descriptionText).toBe("");
    });

    it("COLLAPSE-ONLY: never decodes entities or strips tags (Lever text ships verbatim)", () => {
      // Lever's pipeline is ["collapse"] (the field is already plain text), so an HTML entity or
      // a stray tag is NOT decoded/stripped the way Greenhouse's decode→strip pipeline would —
      // it survives byte-for-byte. This is the load-bearing difference from the Greenhouse mapper.
      const job = mapJob({ ...RAW_JOB, descriptionPlain: "Build  &amp;  ship <b>fast</b> — café" });
      expect(job?.descriptionText).toBe("Build &amp; ship <b>fast</b> — café");
    });
  });

  describe("bad-row guards return null (skip + count, never throw)", () => {
    it.each([
      ["non-record raw (string)", "not-an-object"],
      ["non-record raw (number)", 42],
      ["null raw", null],
      ["id is missing", (() => {
        const { id: _id, ...rest } = RAW_JOB;
        return rest;
      })()],
      ["id is an empty string", { ...RAW_JOB, id: "" }],
      ["id is whitespace-only", { ...RAW_JOB, id: "   " }],
      ["id is a non-string (number)", { ...RAW_JOB, id: 4567890 }],
      ["text is missing", (() => {
        const { text: _text, ...rest } = RAW_JOB;
        return rest;
      })()],
      ["text is a non-string", { ...RAW_JOB, text: 123 }],
      ["both applyUrl and hostedUrl are missing", (() => {
        const { applyUrl: _a, hostedUrl: _h, ...rest } = RAW_JOB;
        return rest;
      })()],
      ["both applyUrl and hostedUrl are empty", { ...RAW_JOB, applyUrl: "", hostedUrl: "" }],
    ])("returns null for %s", (_label, raw) => {
      expect(mapJob(raw)).toBeNull();
    });

    // interior-whitespace id → skip (null), never throw — mapItem contract; regression for the jobId throw.
    it("skips an interior-whitespace id without throwing", () => {
      expect(() => mapJob({ ...RAW_JOB, id: "ab cd" })).not.toThrow();
      expect(mapJob({ ...RAW_JOB, id: "ab cd" })).toBeNull();
    });
  });
});

describe("leverAdapter.normalizeSlug", () => {
  // Lever slugs are case-sensitive, so the per-source canonicalizer trims ONLY — it must NOT
  // lowercase (that would break the case-sensitive board lookup).
  it("preserves casing while trimming via the universal floor", () => {
    expect(leverAdapter.normalizeSlug("  MixedCaseCo  ")).toBe("MixedCaseCo");
  });
});
