import { companySlug } from "@opusfinder/shared";
import type { NormalizedJob } from "@opusfinder/shared";
import { describe, expect, it } from "vitest";

import { ashbyAdapter } from "./ashby";
import type { SourceContext } from "./types";

// Leaf pure-unit for ashbyAdapter.mapItem — the raw-API → NormalizedJob mapper. The load-bearing
// rules this locks: `remote` derives from STRUCTURED workplaceType (NOT the isRemote field, which is
// true on Hybrid postings), the description prefers plain text and falls back to single-encoded HTML,
// publishedAt parses-or-nulls (never a fallback field), and bad/empty items skip via `null` rather
// than throwing. mapItem is the only surface that needs a SourceContext; the slug is supplied branded
// by the caller, so `companySlug` here mirrors how the registry hands ctx in.
const CTX: SourceContext = {
  slug: companySlug("Ramp"),
  rawSlug: "Ramp",
};

// One frozen, realistic Ashby posting. Fields mirror the posting-api/job-board envelope: structured
// workplaceType + the TRAP isRemote, primary location + secondaryLocations, plain + html descriptions.
const RAW_JOB = Object.freeze({
  id: "a1b2c3d4-0000-4eee-8fff-000000000001",
  title: "Senior Platform Engineer",
  location: "Remote - United States",
  secondaryLocations: [{ location: "Remote - Canada" }, { location: "New York, NY" }],
  workplaceType: "Remote",
  isRemote: true,
  descriptionPlain: "Build   the\n\tbest pipeline.  ",
  descriptionHtml: "<p>ignored when plain is present</p>",
  publishedAt: "2026-06-01T12:00:00.000Z",
  applyUrl: "https://jobs.ashbyhq.com/Ramp/a1b2c3d4",
  jobUrl: "https://api.ashbyhq.com/posting-api/job-board/Ramp",
});

describe("ashbyAdapter.mapItem — happy path field-by-field", () => {
  const job = ashbyAdapter.mapItem(RAW_JOB, CTX) as NormalizedJob;

  it("returns a non-null job", () => {
    expect(job).not.toBeNull();
  });

  it("tags the source literal", () => {
    expect(job.source).toBe("ashby");
  });

  it("brands the ATS id verbatim as externalId", () => {
    expect(job.externalId).toBe("a1b2c3d4-0000-4eee-8fff-000000000001");
  });

  it("passes the title through unchanged (no casing transform)", () => {
    expect(job.title).toBe("Senior Platform Engineer");
  });

  it("echoes ctx.slug as companySlug, case-preserved", () => {
    expect(job.companySlug).toBe("Ramp");
  });

  it("collects primary then secondary locations, in order", () => {
    expect(job.locations).toEqual([
      "Remote - United States",
      "Remote - Canada",
      "New York, NY",
    ]);
  });

  it("resolves remote from workplaceType=Remote (not isRemote)", () => {
    expect(job.remote).toBe(true);
  });

  it("collapses descriptionPlain whitespace", () => {
    expect(job.descriptionText).toBe("Build the best pipeline.");
  });

  it("keeps the apply URL", () => {
    expect(job.applyUrl).toBe("https://jobs.ashbyhq.com/Ramp/a1b2c3d4");
  });

  it("parses publishedAt into a Date", () => {
    expect(job.postedAt).toEqual(new Date("2026-06-01T12:00:00.000Z"));
  });

  it("preserves the untouched raw object", () => {
    expect(job.raw).toBe(RAW_JOB);
  });
});

describe("ashbyAdapter.mapItem — remote enum traps", () => {
  // workplaceType is authoritative for the KNOWN spellings; isRemote is deliberately ignored.
  it.each([
    ["Remote", true],
    ["Hybrid", false],
    ["OnSite", false],
  ] as const)("workplaceType=%s ⇒ remote=%s even with isRemote:true", (workplaceType, expected) => {
    const job = ashbyAdapter.mapItem(
      { ...RAW_JOB, workplaceType, isRemote: true, location: "San Francisco, CA", secondaryLocations: [] },
      CTX,
    ) as NormalizedJob;
    expect(job.remote).toBe(expected);
  });

  it.each([
    // No / unrecognized structured value ⇒ infer from the location TEXT (word-boundary "remote").
    [undefined, "Remote - Anywhere", true],
    [null, "Austin, TX", false],
    ["Flexible", "Remote (US)", true],
    ["Flexible", "London, UK", false],
  ] as const)(
    "workplaceType=%j with location %j infers remote=%s",
    (workplaceType, location, expected) => {
      const job = ashbyAdapter.mapItem(
        { ...RAW_JOB, workplaceType, location, secondaryLocations: [] },
        CTX,
      ) as NormalizedJob;
      expect(job.remote).toBe(expected);
    },
  );
});

describe("ashbyAdapter.mapItem — location extraction edges", () => {
  it("trims each location and drops blank / non-string entries", () => {
    const job = ashbyAdapter.mapItem(
      {
        ...RAW_JOB,
        location: "  Berlin  ",
        secondaryLocations: [
          { location: "   " },
          { location: "  Paris " },
          { location: 42 },
          { notLocation: "Tokyo" },
          "not-a-record",
        ],
      },
      CTX,
    ) as NormalizedJob;
    expect(job.locations).toEqual(["Berlin", "Paris"]);
  });

  it("returns an empty array when no usable location is present", () => {
    const job = ashbyAdapter.mapItem(
      { ...RAW_JOB, location: "", secondaryLocations: undefined },
      CTX,
    ) as NormalizedJob;
    expect(job.locations).toEqual([]);
  });

  it("keeps duplicate location strings (no dedupe/sort in this adapter)", () => {
    const job = ashbyAdapter.mapItem(
      { ...RAW_JOB, location: "Remote - US", secondaryLocations: [{ location: "Remote - US" }] },
      CTX,
    ) as NormalizedJob;
    expect(job.locations).toEqual(["Remote - US", "Remote - US"]);
  });
});

describe("ashbyAdapter.mapItem — description source + fallback", () => {
  it("falls back to descriptionHtml when descriptionPlain is empty (strip → decode → collapse)", () => {
    const job = ashbyAdapter.mapItem(
      {
        ...RAW_JOB,
        descriptionPlain: "   ",
        descriptionHtml: "<p>Ship&nbsp;fast  &amp; <b>safe</b></p>",
      },
      CTX,
    ) as NormalizedJob;
    expect(job.descriptionText).toBe("Ship fast & safe");
  });

  it("yields empty text when neither description field is usable", () => {
    const job = ashbyAdapter.mapItem(
      { ...RAW_JOB, descriptionPlain: "", descriptionHtml: undefined },
      CTX,
    ) as NormalizedJob;
    expect(job.descriptionText).toBe("");
  });
});

describe("ashbyAdapter.mapItem — postedAt parsing", () => {
  it("nulls postedAt for a missing publishedAt", () => {
    const { publishedAt: _omit, ...noDate } = RAW_JOB;
    const job = ashbyAdapter.mapItem(noDate, CTX) as NormalizedJob;
    expect(job.postedAt).toBeNull();
  });

  it("nulls postedAt for an unparseable date string", () => {
    const job = ashbyAdapter.mapItem({ ...RAW_JOB, publishedAt: "not-a-date" }, CTX) as NormalizedJob;
    expect(job.postedAt).toBeNull();
  });

  it("nulls postedAt for a non-string publishedAt", () => {
    const job = ashbyAdapter.mapItem({ ...RAW_JOB, publishedAt: 1717243200000 }, CTX) as NormalizedJob;
    expect(job.postedAt).toBeNull();
  });
});

describe("ashbyAdapter.mapItem — applyUrl resolution", () => {
  it("falls back to jobUrl when applyUrl is absent", () => {
    const { applyUrl: _omit, ...noApply } = RAW_JOB;
    const job = ashbyAdapter.mapItem(noApply, CTX) as NormalizedJob;
    expect(job.applyUrl).toBe("https://api.ashbyhq.com/posting-api/job-board/Ramp");
  });

  it("falls back to jobUrl when applyUrl is an EMPTY string (truthiness, not presence)", () => {
    const job = ashbyAdapter.mapItem({ ...RAW_JOB, applyUrl: "" }, CTX) as NormalizedJob;
    expect(job.applyUrl).toBe("https://api.ashbyhq.com/posting-api/job-board/Ramp");
  });
});

describe("ashbyAdapter.mapItem — title validation boundary", () => {
  // The id is trim-guarded but the title is only TYPE-checked: an empty-string title is a valid
  // job (kept verbatim), whereas a non-string title skips as null. Locks that asymmetry so a future
  // "require non-empty title" tweak is a deliberate change, not an accident.
  it("keeps an empty-string title (type-checked, not emptiness-checked)", () => {
    const job = ashbyAdapter.mapItem({ ...RAW_JOB, title: "" }, CTX) as NormalizedJob;
    expect(job).not.toBeNull();
    expect(job.title).toBe("");
  });
});

describe("ashbyAdapter.mapItem — skip-as-null (never throw) on bad items", () => {
  it.each([
    ["non-record input", 42],
    ["null input", null],
    ["missing id", { ...RAW_JOB, id: undefined }],
    ["empty id", { ...RAW_JOB, id: "" }],
    ["whitespace-only id", { ...RAW_JOB, id: "   " }],
    ["non-string title", { ...RAW_JOB, title: 123 }],
    ["no applyUrl or jobUrl", { ...RAW_JOB, applyUrl: undefined, jobUrl: undefined }],
  ])("returns null for %s", (_label, raw) => {
    expect(ashbyAdapter.mapItem(raw, CTX)).toBeNull();
  });

  // interior-whitespace id → skip (null), never throw — mapItem contract; regression for the jobId throw.
  it("skips an interior-whitespace id without throwing", () => {
    expect(() => ashbyAdapter.mapItem({ ...RAW_JOB, id: "ab cd" }, CTX)).not.toThrow();
    expect(ashbyAdapter.mapItem({ ...RAW_JOB, id: "ab cd" }, CTX)).toBeNull();
  });
});
