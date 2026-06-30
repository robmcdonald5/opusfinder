import { unsafeCompanySlug } from "@opusfinder/shared";
import { describe, expect, it } from "vitest";

import { greenhouseAdapter } from "./greenhouse";
import type { SourceContext } from "./types";

// Leaf pure-unit for the Greenhouse mapper (mapItem → toNormalizedJob). This is the contract
// that turns one untrusted board-API job into a NormalizedJob, and its quirks are load-bearing:
//   - posting-date fallback uses `||` (NOT `??`) so an EMPTY first_published falls back to
//     updated_at instead of being kept as an unparseable "";
//   - `remote` is inferred ONLY from a `\bremote\b` word-boundary match on the location string,
//     so "Hybrid"/"Remoteville" must stay false;
//   - the bad-row guards return `null` (skip + count) rather than throwing, so one malformed job
//     can't abort a whole page;
//   - `content` is asymmetrically DOUBLE-encoded, so the decode→strip→decode→collapse pipeline is
//     the only thing that yields clean text.
// Ctx.slug is already branded/lowercased by normalizeSlug upstream; mapItem just stamps it on.
const ctx: SourceContext = Object.freeze({
  slug: unsafeCompanySlug("acme"),
  rawSlug: "Acme",
});

// A frozen, realistic board-API job (the `?content=true` shape: numeric id, ISO dates, and
// content that is single-encoded around tags + double-encoded around inner entities).
const RAW_JOB = Object.freeze({
  id: 4567890,
  title: "Staff Software Engineer",
  absolute_url: "https://boards.greenhouse.io/acme/jobs/4567890",
  location: Object.freeze({ name: "Remote - United States" }),
  first_published: "2026-06-01T12:00:00.000Z",
  updated_at: "2026-06-20T08:30:00.000Z",
  content: "&lt;p&gt;Build &amp;amp; ship&lt;/p&gt;",
});

function mapJob(raw: unknown) {
  return greenhouseAdapter.mapItem(raw, ctx);
}

describe("greenhouseAdapter.mapItem", () => {
  it("maps a complete raw job field-by-field", () => {
    const job = mapJob(RAW_JOB);

    expect(job).not.toBeNull();
    expect(job).toMatchObject({
      source: "greenhouse",
      externalId: "4567890",
      title: "Staff Software Engineer",
      companySlug: "acme",
      locations: ["Remote - United States"],
      remote: true,
      descriptionText: "Build & ship",
      applyUrl: "https://boards.greenhouse.io/acme/jobs/4567890",
    });
    // numeric id is stringified before branding.
    expect(job?.externalId).toBe("4567890");
    expect(job?.postedAt?.toISOString()).toBe("2026-06-01T12:00:00.000Z");
    // raw is preserved by identity for downstream reprocessing.
    expect(job?.raw).toBe(RAW_JOB);
  });

  it("maps an id of 0 (falsy but finite — a `!id` guard would wrongly drop it)", () => {
    const job = mapJob({ ...RAW_JOB, id: 0 });
    expect(job).not.toBeNull();
    expect(job?.externalId).toBe("0");
  });

  it("keeps the title verbatim (no casing/whitespace normalization here)", () => {
    const job = mapJob({ ...RAW_JOB, title: "  iOS & macOS DEVELOPER  " });
    expect(job?.title).toBe("  iOS & macOS DEVELOPER  ");
  });

  describe("posting-date fallback", () => {
    it("prefers first_published when present", () => {
      const job = mapJob({ ...RAW_JOB, first_published: "2026-01-15T00:00:00.000Z" });
      expect(job?.postedAt?.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    });

    it("falls back to updated_at when first_published is an EMPTY string (|| not ??)", () => {
      const job = mapJob({ ...RAW_JOB, first_published: "" });
      expect(job?.postedAt?.toISOString()).toBe("2026-06-20T08:30:00.000Z");
    });

    it("falls back to updated_at when first_published is missing", () => {
      const { first_published: _omit, ...rest } = RAW_JOB;
      const job = mapJob(rest);
      expect(job?.postedAt?.toISOString()).toBe("2026-06-20T08:30:00.000Z");
    });

    it("falls back when first_published is a non-string value", () => {
      const job = mapJob({ ...RAW_JOB, first_published: 1234567890 });
      expect(job?.postedAt?.toISOString()).toBe("2026-06-20T08:30:00.000Z");
    });

    it("is null when neither date is present", () => {
      const { first_published: _f, updated_at: _u, ...rest } = RAW_JOB;
      const job = mapJob(rest);
      expect(job?.postedAt).toBeNull();
    });

    it("is null when the date string is unparseable", () => {
      const job = mapJob({ ...RAW_JOB, first_published: "not-a-date", updated_at: "also-bad" });
      expect(job?.postedAt).toBeNull();
    });
  });

  describe("remote inference (\\bremote\\b word-boundary, case-insensitive)", () => {
    it.each([
      ["Remote - United States", true],
      ["REMOTE", true],
      ["Remote, EMEA", true],
      ["San Francisco, CA", false],
      ["Hybrid - San Francisco", false],
      ["Remoteville, OH", false],
      ["", false],
    ])("location %j → remote=%s", (name, expected) => {
      const job = mapJob({ ...RAW_JOB, location: { name } });
      expect(job?.remote).toBe(expected);
    });
  });

  describe("location handling", () => {
    it("trims a present location name into a single-element array", () => {
      const job = mapJob({ ...RAW_JOB, location: { name: "  London, UK  " } });
      expect(job?.locations).toEqual(["London, UK"]);
    });

    it.each([
      ["empty name", { name: "" }],
      ["whitespace-only name", { name: "   " }],
      ["non-string name", { name: 42 }],
      ["location not a record", "London"],
    ])("yields an empty locations array (%s) and remote=false", (_label, location) => {
      const job = mapJob({ ...RAW_JOB, location });
      expect(job?.locations).toEqual([]);
      expect(job?.remote).toBe(false);
    });

    it("yields an empty locations array when location is missing entirely", () => {
      const { location: _omit, ...rest } = RAW_JOB;
      const job = mapJob(rest);
      expect(job?.locations).toEqual([]);
    });
  });

  describe("descriptionText cleaning (decode → strip → decode → collapse)", () => {
    it("decodes the double-encoded body and collapses whitespace", () => {
      const job = mapJob({
        ...RAW_JOB,
        content: "&lt;div&gt;Senior&amp;nbsp;Engineer&lt;/div&gt;&lt;p&gt;  Apply  now &lt;/p&gt;",
      });
      expect(job?.descriptionText).toBe("Senior Engineer Apply now");
    });

    it("is an empty string when content is missing", () => {
      const { content: _omit, ...rest } = RAW_JOB;
      expect(mapJob(rest)?.descriptionText).toBe("");
    });

    it("is an empty string when content is not a string", () => {
      const job = mapJob({ ...RAW_JOB, content: { html: "<p>x</p>" } });
      expect(job?.descriptionText).toBe("");
    });
  });

  describe("bad-row guards return null (skip + count, never throw)", () => {
    it.each([
      ["non-record raw", "not-an-object"],
      ["null raw", null],
      ["id is a string", { ...RAW_JOB, id: "4567890" }],
      ["id is NaN", { ...RAW_JOB, id: Number.NaN }],
      ["id is Infinity", { ...RAW_JOB, id: Number.POSITIVE_INFINITY }],
      ["title is missing", (() => {
        const { title: _t, ...rest } = RAW_JOB;
        return rest;
      })()],
      ["title is not a string", { ...RAW_JOB, title: 123 }],
      ["absolute_url is not a string", { ...RAW_JOB, absolute_url: null }],
    ])("returns null for %s", (_label, raw) => {
      expect(mapJob(raw)).toBeNull();
    });
  });
});

describe("greenhouseAdapter.normalizeSlug", () => {
  // Board tokens are lowercase; the per-source lowercasing lives here (companySlug() must NOT
  // change casing because case-sensitive platforms rely on it).
  it("lowercases the board token before branding", () => {
    expect(greenhouseAdapter.normalizeSlug("Acme-Corp")).toBe("acme-corp");
  });

  it("trims surrounding whitespace via the universal floor", () => {
    expect(greenhouseAdapter.normalizeSlug("  Acme  ")).toBe("acme");
  });
});
