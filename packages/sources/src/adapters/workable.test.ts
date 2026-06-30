import { companySlug } from "@opusfinder/shared";
import { describe, expect, it } from "vitest";

import type { SourceContext } from "./types";
import { workableAdapter } from "./workable";

// Leaf pure-unit for the Workable adapter's mapItem (raw widget-API posting → NormalizedJob).
// Load-bearing: this is the ONLY place Workable's raw shape is interpreted, so the field-by-field
// contract here is what guards retrieval/dedupe/digest downstream — the posting-date `||` fallback
// (empty published_on must fall THROUGH to created_at), the telecommuting-OR-text remote rule
// (hybrid stays false; text-only remote with telecommuting=false still flags true), hidden-location
// skipping with the flat top-level fallback, and the null-skip guards (no shortcode/title/applyUrl).

const ctx: SourceContext = { slug: companySlug("acme"), rawSlug: "Acme" };

// One frozen, realistic ?details=true posting. Individual cases clone + override single fields so
// each test owns exactly one concern while sharing this baseline shape.
const RAW_POSTING = Object.freeze({
  shortcode: "A1B2C3D4",
  title: "Senior Platform Engineer",
  url: "https://apply.workable.com/acme/j/A1B2C3D4/",
  shortlink: "https://apply.workable.com/j/A1B2C3D4",
  telecommuting: false,
  published_on: "2026-06-01",
  created_at: "2026-05-20",
  description: "<p>Build&nbsp;the&nbsp;platform &amp; ship.</p>",
  locations: [
    { city: "Berlin", region: "Berlin", country: "Germany" },
    { city: "Lisbon", region: "Lisbon", country: "Portugal" },
  ],
});

function mapPosting(overrides: Record<string, unknown>) {
  return workableAdapter.mapItem({ ...RAW_POSTING, ...overrides }, ctx);
}

describe("workableAdapter.mapItem", () => {
  it("normalizes a full posting field-by-field", () => {
    const job = workableAdapter.mapItem(RAW_POSTING, ctx);

    expect(job).toEqual({
      source: "workable",
      externalId: "A1B2C3D4",
      title: "Senior Platform Engineer",
      companySlug: "acme",
      locations: ["Berlin, Berlin, Germany", "Lisbon, Lisbon, Portugal"],
      remote: false,
      descriptionText: "Build the platform & ship.",
      applyUrl: "https://apply.workable.com/acme/j/A1B2C3D4/",
      postedAt: new Date("2026-06-01"),
      raw: RAW_POSTING,
    });
  });

  it("preserves the untouched raw object by identity", () => {
    const job = workableAdapter.mapItem(RAW_POSTING, ctx);
    expect(job?.raw).toBe(RAW_POSTING);
  });

  describe("skip guards return null (never throw)", () => {
    it.each([
      ["string raw", "not-an-object" as unknown],
      ["null raw", null],
      ["undefined raw", undefined],
      ["number raw", 42],
      ["boolean raw", true],
    ])("%s → null", (_label, raw) => {
      expect(workableAdapter.mapItem(raw, ctx)).toBeNull();
    });

    it.each([
      ["missing shortcode", { shortcode: undefined }],
      ["non-string shortcode", { shortcode: 1234 }],
      ["empty shortcode", { shortcode: "" }],
      ["whitespace-only shortcode", { shortcode: "   " }],
      ["non-string title", { title: 42 }],
      ["url and shortlink both absent", { url: undefined, shortlink: undefined }],
      ["url empty + no shortlink", { url: "", shortlink: undefined }],
    ])("%s → null", (_label, overrides) => {
      expect(mapPosting(overrides)).toBeNull();
    });

    // interior-whitespace shortcode → skip (null), never throw — mapItem contract; regression for the jobId throw.
    it("skips an interior-whitespace shortcode without throwing", () => {
      expect(() => mapPosting({ shortcode: "ab cd" })).not.toThrow();
      expect(mapPosting({ shortcode: "ab cd" })).toBeNull();
    });
  });

  describe("externalId", () => {
    it("trims surrounding whitespace off the shortcode", () => {
      expect(mapPosting({ shortcode: "  A1B2C3D4  " })?.externalId).toBe("A1B2C3D4");
    });
  });

  describe("applyUrl fallback", () => {
    it("prefers url over shortlink", () => {
      expect(mapPosting({})?.applyUrl).toBe("https://apply.workable.com/acme/j/A1B2C3D4/");
    });

    it("falls back to shortlink when url is empty", () => {
      expect(mapPosting({ url: "" })?.applyUrl).toBe("https://apply.workable.com/j/A1B2C3D4");
    });

    it("falls back to shortlink when url is a non-string", () => {
      expect(mapPosting({ url: null })?.applyUrl).toBe("https://apply.workable.com/j/A1B2C3D4");
    });
  });

  describe("remote", () => {
    it("is true when the structured telecommuting flag is set", () => {
      expect(mapPosting({ telecommuting: true })?.remote).toBe(true);
    });

    it("infers true from location text even when telecommuting is false", () => {
      const job = mapPosting({
        telecommuting: false,
        locations: [{ city: "Remote", country: "United States" }],
      });
      expect(job?.remote).toBe(true);
    });

    it("stays false for a hybrid posting with no remote signal", () => {
      const job = mapPosting({
        telecommuting: false,
        locations: [{ city: "Hybrid - San Francisco", country: "United States" }],
      });
      expect(job?.remote).toBe(false);
    });

    it("only matches the whole word remote, not a substring", () => {
      const job = mapPosting({
        telecommuting: false,
        locations: [{ city: "Remotely-Adjacent Town", country: "Germany" }],
      });
      expect(job?.remote).toBe(false);
    });
  });

  describe("locations", () => {
    it("skips hidden entries and keeps source order (no sort, no dedupe)", () => {
      const job = mapPosting({
        locations: [
          { city: "Lisbon", country: "Portugal" },
          { city: "Secret", country: "Nowhere", hidden: true },
          { city: "Berlin", country: "Germany" },
          { city: "Lisbon", country: "Portugal" },
        ],
      });
      expect(job?.locations).toEqual([
        "Lisbon, Portugal",
        "Berlin, Germany",
        "Lisbon, Portugal",
      ]);
    });

    it("drops blank/non-string parts when composing a single location", () => {
      const job = mapPosting({
        locations: [{ city: "Austin", region: "", country: "USA" }],
      });
      expect(job?.locations).toEqual(["Austin, USA"]);
    });

    it("falls back to the flat top-level city/state/country when locations[] yields nothing", () => {
      const job = mapPosting({
        locations: [],
        city: "Toronto",
        state: "Ontario",
        country: "Canada",
      });
      expect(job?.locations).toEqual(["Toronto, Ontario, Canada"]);
    });

    it("uses the flat fallback when every locations[] entry is hidden", () => {
      const job = mapPosting({
        locations: [{ city: "Hidden", country: "Nowhere", hidden: true }],
        city: "Paris",
        country: "France",
      });
      expect(job?.locations).toEqual(["Paris, France"]);
    });

    it("is [] when neither structured nor flat location data is present", () => {
      const job = mapPosting({
        locations: undefined,
        city: undefined,
        state: undefined,
        country: undefined,
      });
      expect(job?.locations).toEqual([]);
    });
  });

  describe("postedAt", () => {
    it("uses published_on when present", () => {
      expect(mapPosting({ published_on: "2026-06-01" })?.postedAt).toEqual(new Date("2026-06-01"));
    });

    it("falls through an EMPTY published_on to created_at (|| not ??)", () => {
      expect(mapPosting({ published_on: "" })?.postedAt).toEqual(new Date("2026-05-20"));
    });

    it("falls back to created_at when published_on is a non-string", () => {
      expect(mapPosting({ published_on: null })?.postedAt).toEqual(new Date("2026-05-20"));
    });

    it("is null when no date field is parseable", () => {
      expect(mapPosting({ published_on: "not-a-date", created_at: "" })?.postedAt).toBeNull();
    });

    it("is null when both date fields are absent", () => {
      expect(mapPosting({ published_on: undefined, created_at: undefined })?.postedAt).toBeNull();
    });
  });

  describe("descriptionText", () => {
    it("strips tags, decodes one entity layer, and collapses whitespace", () => {
      const job = mapPosting({
        description: "<div>Hello&nbsp;&amp;  <b>welcome</b>\n  here</div>",
      });
      expect(job?.descriptionText).toBe("Hello & welcome here");
    });

    it("decodes numeric (astral) entities through the strip→decode→collapse recipe", () => {
      const job = mapPosting({
        description: "<p>Ship&#32;it&#32;&#128640;</p>",
      });
      expect(job?.descriptionText).toBe("Ship it 🚀");
    });

    it.each([
      ["absent", undefined],
      ["non-string number", 99],
      ["null", null],
    ])("is '' when description is %s", (_label, description) => {
      expect(mapPosting({ description })?.descriptionText).toBe("");
    });
  });
});
