import { describe, expect, it } from "vitest";

import { companySlug } from "@opusfinder/shared";

import { gemAdapter } from "./gem";
import type { SourceContext } from "./types";

// Leaf pure-unit (no network/DB). `gemAdapter.mapItem` is the raw-Gem-job → NormalizedJob mapper.
// The load-bearing rules locked here are the ones a regression would silently corrupt downstream:
// (1) per-item resilience — a malformed item returns `null` (skip+count) and NEVER throws, so one
// bad row can't abort the whole board; (2) the structured `location_type` enum wins over text
// inference, with absent/unknown values falling back to the location string; (3) `offices[]` wins
// over the single `location`, locations are trimmed/blank-dropped but kept VERBATIM (no sort, no
// dedupe — Gem's order is meaningful); (4) `content_plain` is preferred over the HTML `content`
// fallback; (5) `first_published_at` is the ONLY date source (unparseable/absent ⇒ null).

/** Branded context every descriptor method receives. `slug` is what mapItem copies onto `companySlug`. */
const CTX: SourceContext = { slug: companySlug("acme-corp"), rawSlug: "Acme-Corp" };

/** A minimal raw item that maps successfully, so each case can override ONE field in isolation. */
const validBase = {
  id: "1",
  title: "Engineer",
  absolute_url: "https://jobs.gem.com/acme-corp/1",
} as const;

const raw = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  ...validBase,
  ...overrides,
});

describe("gemAdapter.mapItem", () => {
  // A frozen, realistic multi-office board item exercising every field at once.
  const FULL_RAW = Object.freeze({
    id: "  12345  ", // surrounding whitespace is trimmed by jobId()
    title: "Senior Backend Engineer", // title is passed through VERBATIM — no casing applied
    absolute_url: "https://jobs.gem.com/acme-corp/12345",
    location_type: "in_office",
    first_published_at: "2026-03-15T09:00:00.000Z",
    content_plain: "Build   great   things.\nJoin us.", // collapse-only
    content: "<p>ignored html</p>",
    offices: [
      { location: { name: "  San Francisco  " } },
      { location: { name: "New York City" } },
    ],
    location: { name: "This Single Location Is Ignored When Offices Exist" },
  });

  it("normalizes a full multi-office posting field-by-field", () => {
    const job = gemAdapter.mapItem(FULL_RAW, CTX);

    expect(job).not.toBeNull();
    expect(job?.source).toBe("gem");
    expect(job?.externalId).toBe("12345");
    expect(job?.title).toBe("Senior Backend Engineer");
    expect(job?.companySlug).toBe("acme-corp");
    expect(job?.locations).toEqual(["San Francisco", "New York City"]);
    expect(job?.remote).toBe(false);
    expect(job?.descriptionText).toBe("Build great things. Join us.");
    expect(job?.applyUrl).toBe("https://jobs.gem.com/acme-corp/12345");
    expect(job?.postedAt).toBeInstanceOf(Date);
    expect(job?.postedAt?.toISOString()).toBe("2026-03-15T09:00:00.000Z");
    // raw is preserved by REFERENCE for debugging/reprocessing.
    expect(job?.raw).toBe(FULL_RAW);
  });

  describe("returns null (skip+count, never throw) for malformed items", () => {
    it.each<[string, unknown]>([
      ["a non-record string", "not an object"],
      ["a non-record number", 42],
      ["null", null],
      ["a bare array", []],
      ["missing id", raw({ id: undefined })],
      ["a non-string id", raw({ id: 123 })],
      ["a whitespace-only id", raw({ id: "   " })],
      ["an empty id", raw({ id: "" })],
      ["a non-string title", raw({ title: 42 })],
      ["missing absolute_url", raw({ absolute_url: undefined })],
      ["an empty absolute_url", raw({ absolute_url: "" })],
      ["a non-string absolute_url", raw({ absolute_url: 123 })],
    ])("%s", (_label, input) => {
      expect(gemAdapter.mapItem(input, CTX)).toBeNull();
    });

    // interior-whitespace id → skip (null), never throw — mapItem contract; regression for the jobId throw.
    it("skips an interior-whitespace id without throwing", () => {
      expect(() => gemAdapter.mapItem(raw({ id: "ab cd" }), CTX)).not.toThrow();
      expect(gemAdapter.mapItem(raw({ id: "ab cd" }), CTX)).toBeNull();
    });
  });

  describe("remote flag — structured enum wins, else infer from text", () => {
    it.each<[string, Record<string, unknown>, boolean]>([
      [
        "'remote' enum forces true even with no remote text",
        { location_type: "remote", location: { name: "San Francisco" } },
        true,
      ],
      [
        "'hybrid' enum forces false even when the location says Remote",
        { location_type: "hybrid", location: { name: "Remote - United States" } },
        false,
      ],
      [
        "'in_office' enum forces false",
        { location_type: "in_office", location: { name: "London" } },
        false,
      ],
      [
        "absent enum infers true from 'Remote' in the text",
        { location: { name: "Remote - United States" } },
        true,
      ],
      [
        "absent enum infers false from an onsite location",
        { location: { name: "Austin, TX" } },
        false,
      ],
      [
        "unknown enum value falls through to text inference",
        { location_type: "flexible", location: { name: "Remote - EU" } },
        true,
      ],
      [
        "non-string enum is ignored, infers from text",
        { location_type: 7, location: { name: "Remote" } },
        true,
      ],
      [
        "enum match is case-sensitive — 'REMOTE' is not the literal, so onsite text ⇒ false",
        { location_type: "REMOTE", location: { name: "Austin, TX" } },
        false,
      ],
    ])("%s", (_label, overrides, expected) => {
      expect(gemAdapter.mapItem(raw(overrides), CTX)?.remote).toBe(expected);
    });
  });

  describe("locations — offices win, trimmed, blank-dropped, order preserved", () => {
    it("prefers offices[] over the single location and keeps source order", () => {
      const job = gemAdapter.mapItem(
        raw({
          offices: [{ location: { name: "Berlin" } }, { location: { name: "Amsterdam" } }],
          location: { name: "Ignored" },
        }),
        CTX,
      );
      expect(job?.locations).toEqual(["Berlin", "Amsterdam"]);
    });

    it("does NOT sort or dedupe — Gem's repeated/unsorted order is kept verbatim", () => {
      const job = gemAdapter.mapItem(
        raw({
          offices: [
            { location: { name: "Tokyo" } },
            { location: { name: "Berlin" } },
            { location: { name: "Tokyo" } },
          ],
        }),
        CTX,
      );
      expect(job?.locations).toEqual(["Tokyo", "Berlin", "Tokyo"]);
    });

    it("drops blank/whitespace and malformed office entries", () => {
      const job = gemAdapter.mapItem(
        raw({
          offices: [
            { location: { name: "  Paris  " } },
            { location: { name: "   " } },
            { location: { name: 123 } },
            "not-an-office",
            { location: null },
          ],
        }),
        CTX,
      );
      expect(job?.locations).toEqual(["Paris"]);
    });

    it("falls back to the single location when offices yields nothing", () => {
      const job = gemAdapter.mapItem(
        raw({ offices: [{ location: { name: "   " } }], location: { name: "  Remote - US  " } }),
        CTX,
      );
      expect(job?.locations).toEqual(["Remote - US"]);
    });

    it("is empty when neither offices nor location supply a name", () => {
      const job = gemAdapter.mapItem(raw({}), CTX);
      expect(job?.locations).toEqual([]);
    });
  });

  describe("descriptionText — content_plain preferred over the HTML fallback", () => {
    it("collapses content_plain whitespace and ignores content when content_plain is non-blank", () => {
      const job = gemAdapter.mapItem(
        raw({ content_plain: "  Hello   plain\n\nworld  ", content: "<p>HTML body</p>" }),
        CTX,
      );
      expect(job?.descriptionText).toBe("Hello plain world");
    });

    it("treats content_plain as collapse-only — tags/entities are kept verbatim (no strip, no decode)", () => {
      // The content_plain branch runs cleanHtml(plain, ["collapse"]); unlike the `content`
      // fallback it does NOT strip tags or decode entities. Locks that Gem's plain field is
      // trusted as-is so a future "always strip" tweak can't silently mangle real plain text.
      const job = gemAdapter.mapItem(
        raw({ content_plain: "Ship  <b>fast</b>  &amp;  often" }),
        CTX,
      );
      expect(job?.descriptionText).toBe("Ship <b>fast</b> &amp; often");
    });

    it("falls back to stripped+decoded HTML content when content_plain is blank", () => {
      const job = gemAdapter.mapItem(
        raw({ content_plain: "   ", content: "<p>Build&nbsp;things &amp; ship</p>" }),
        CTX,
      );
      expect(job?.descriptionText).toBe("Build things & ship");
    });

    it("is empty when neither content_plain nor content is present", () => {
      const job = gemAdapter.mapItem(raw({}), CTX);
      expect(job?.descriptionText).toBe("");
    });
  });

  describe("postedAt — first_published_at is the only date source", () => {
    it("parses a valid ISO timestamp", () => {
      const job = gemAdapter.mapItem(raw({ first_published_at: "2026-01-02T03:04:05.000Z" }), CTX);
      expect(job?.postedAt?.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    });

    it.each<[string, Record<string, unknown>]>([
      ["the field is absent", {}],
      ["the field is empty", { first_published_at: "" }],
      ["the field is unparseable", { first_published_at: "not-a-date" }],
      ["the field is non-string", { first_published_at: 1700000000000 }],
    ])("is null when %s", (_label, overrides) => {
      expect(gemAdapter.mapItem(raw(overrides), CTX)?.postedAt).toBeNull();
    });
  });
});
