import { companySlug } from "@opusfinder/shared";
import { describe, expect, it } from "vitest";

import { recruiteeAdapter } from "./recruitee";
import type { SourceContext } from "./types";

// Leaf pure-unit for the Recruitee mapper (recruiteeAdapter.mapItem). The normalization here is the
// load-bearing contract: a raw `/api/offers/` item → a fully-valid NormalizedJob, with the three
// quirks that have silently corrupted output before — numeric `id` (stringify before branding), the
// three INDEPENDENT remote booleans (hybrid wins, then remote, then on_site, else infer), and the
// non-ISO `published_at` ("YYYY-MM-DD HH:MM:SS UTC") that a Cloudflare Worker's stricter Date refuses
// to parse raw. Locale-agnostic + frozen fixtures so a regression in any of those shows up here.

// ctx is the branded slug the caller produced via normalizeSlug; companySlug is NOT applied again in
// the mapper, so `companySlug` on the output must echo ctx.slug verbatim (casing preserved).
const ctx: SourceContext = { slug: companySlug("acme-corp"), rawSlug: "Acme-Corp" };

/** A complete, realistic Recruitee offer — the shape every field-by-field assertion derives from. */
const RAW_OFFER = Object.freeze({
  id: 482915,
  title: "Senior Platform Engineer",
  careers_apply_url: "https://acme-corp.recruitee.com/o/senior-platform-engineer/c/new",
  careers_url: "https://acme-corp.recruitee.com/o/senior-platform-engineer",
  description: "<p>Build the <b>platform</b>.</p>&amp; ship it&nbsp;fast.",
  requirements: "<ul><li>5y experience</li></ul>",
  published_at: "2026-06-20 14:30:00 UTC",
  remote: false,
  hybrid: false,
  on_site: true,
  locations: [{ name: "Berlin" }, { name: "Amsterdam" }],
  location: "Berlin, Germany",
});

describe("recruiteeAdapter.mapItem", () => {
  it("maps a full offer field-by-field into the normalized shape", () => {
    const job = recruiteeAdapter.mapItem(RAW_OFFER, ctx);

    expect(job).toEqual({
      source: "recruitee",
      externalId: "482915", // numeric id stringified before branding
      title: "Senior Platform Engineer",
      companySlug: "acme-corp",
      locations: ["Berlin", "Amsterdam"],
      remote: false,
      descriptionText: "Build the platform . & ship it fast.",
      applyUrl: "https://acme-corp.recruitee.com/o/senior-platform-engineer/c/new",
      postedAt: new Date("2026-06-20T14:30:00.000Z"),
      raw: RAW_OFFER,
    });
  });

  it("keeps the original raw object by reference for reprocessing", () => {
    const job = recruiteeAdapter.mapItem(RAW_OFFER, ctx);
    expect(job?.raw).toBe(RAW_OFFER);
  });

  describe("apply URL fallback", () => {
    it("prefers careers_apply_url when present", () => {
      const job = recruiteeAdapter.mapItem(
        { ...RAW_OFFER, careers_apply_url: "https://apply.example/x", careers_url: "https://list/y" },
        ctx,
      );
      expect(job?.applyUrl).toBe("https://apply.example/x");
    });

    it("falls back to careers_url when careers_apply_url is empty", () => {
      const job = recruiteeAdapter.mapItem(
        { ...RAW_OFFER, careers_apply_url: "", careers_url: "https://acme-corp.recruitee.com/o/x" },
        ctx,
      );
      expect(job?.applyUrl).toBe("https://acme-corp.recruitee.com/o/x");
    });

    it("falls back to careers_url when careers_apply_url is missing", () => {
      const { careers_apply_url, ...rest } = RAW_OFFER;
      void careers_apply_url;
      const job = recruiteeAdapter.mapItem(rest, ctx);
      expect(job?.applyUrl).toBe(RAW_OFFER.careers_url);
    });

    it("returns null when neither apply URL is present", () => {
      const { careers_apply_url, careers_url, ...rest } = RAW_OFFER;
      void careers_apply_url;
      void careers_url;
      expect(recruiteeAdapter.mapItem(rest, ctx)).toBeNull();
    });
  });

  describe("remote resolution — three independent booleans", () => {
    it("hybrid:true wins even when remote:true co-occurs (resolves to false)", () => {
      const job = recruiteeAdapter.mapItem(
        { ...RAW_OFFER, hybrid: true, remote: true, on_site: false },
        ctx,
      );
      expect(job?.remote).toBe(false);
    });

    it("remote:true (no hybrid) resolves to true", () => {
      const job = recruiteeAdapter.mapItem(
        { ...RAW_OFFER, hybrid: false, remote: true, on_site: false },
        ctx,
      );
      expect(job?.remote).toBe(true);
    });

    it("on_site:true overrides a 'Remote' location string (structured wins over inference)", () => {
      const job = recruiteeAdapter.mapItem(
        { ...RAW_OFFER, hybrid: false, remote: false, on_site: true, locations: [{ name: "Remote - US" }] },
        ctx,
      );
      expect(job?.remote).toBe(false);
    });

    it("no structured flags → infers true from a 'Remote' location string", () => {
      const job = recruiteeAdapter.mapItem(
        { ...RAW_OFFER, hybrid: false, remote: false, on_site: false, locations: [{ name: "Remote - US" }] },
        ctx,
      );
      expect(job?.remote).toBe(true);
    });

    it("no structured flags + non-remote location → false", () => {
      const job = recruiteeAdapter.mapItem(
        { ...RAW_OFFER, hybrid: false, remote: false, on_site: false, locations: [{ name: "Berlin" }] },
        ctx,
      );
      expect(job?.remote).toBe(false);
    });
  });

  describe("location extraction", () => {
    it("prefers multi-office locations[].name, trimming each", () => {
      const job = recruiteeAdapter.mapItem(
        { ...RAW_OFFER, locations: [{ name: "  Berlin " }, { name: "London  " }] },
        ctx,
      );
      expect(job?.locations).toEqual(["Berlin", "London"]);
    });

    it("preserves order and keeps duplicates verbatim (no sort, no dedupe)", () => {
      const job = recruiteeAdapter.mapItem(
        { ...RAW_OFFER, locations: [{ name: "Paris" }, { name: "Amsterdam" }, { name: "Paris" }] },
        ctx,
      );
      expect(job?.locations).toEqual(["Paris", "Amsterdam", "Paris"]);
    });

    it("skips blank and non-string location names", () => {
      const job = recruiteeAdapter.mapItem(
        { ...RAW_OFFER, locations: [{ name: "   " }, { name: 42 }, {}, { name: "Oslo" }] },
        ctx,
      );
      expect(job?.locations).toEqual(["Oslo"]);
    });

    it("falls back to the top-level location string only when locations yields nothing", () => {
      const job = recruiteeAdapter.mapItem(
        { ...RAW_OFFER, locations: [], location: "  Madrid, Spain  " },
        ctx,
      );
      expect(job?.locations).toEqual(["Madrid, Spain"]);
    });

    it("returns [] when neither locations nor a top-level location is present", () => {
      const { locations, location, ...rest } = RAW_OFFER;
      void locations;
      void location;
      expect(recruiteeAdapter.mapItem(rest, ctx)?.locations).toEqual([]);
    });
  });

  describe("postedAt parsing", () => {
    it("massages the non-ISO 'YYYY-MM-DD HH:MM:SS UTC' timestamp to a real Date", () => {
      const job = recruiteeAdapter.mapItem(
        { ...RAW_OFFER, published_at: "2026-01-05 09:00:00 UTC" },
        ctx,
      );
      expect(job?.postedAt?.toISOString()).toBe("2026-01-05T09:00:00.000Z");
    });

    it("trims surrounding whitespace BEFORE massaging (a leading space must not become the T separator)", () => {
      const job = recruiteeAdapter.mapItem(
        { ...RAW_OFFER, published_at: "  2026-06-20 14:30:00 UTC  " },
        ctx,
      );
      expect(job?.postedAt?.toISOString()).toBe("2026-06-20T14:30:00.000Z");
    });

    it.each([
      ["missing", undefined],
      ["empty string", ""],
      ["whitespace-only", "   "],
      ["non-string", 1718894400],
      ["unparseable", "not-a-date"],
    ])("postedAt is null for %s published_at", (_label, value) => {
      const job = recruiteeAdapter.mapItem({ ...RAW_OFFER, published_at: value }, ctx);
      expect(job?.postedAt).toBeNull();
    });
  });

  describe("descriptionText", () => {
    it("strips tags, decodes one entity layer, and collapses whitespace", () => {
      const job = recruiteeAdapter.mapItem(
        { ...RAW_OFFER, description: "<p>Hello&nbsp;&amp; <b>welcome</b></p>" },
        ctx,
      );
      expect(job?.descriptionText).toBe("Hello & welcome");
    });

    it("is '' when description is missing or non-string", () => {
      const { description, ...rest } = RAW_OFFER;
      void description;
      expect(recruiteeAdapter.mapItem(rest, ctx)?.descriptionText).toBe("");
      expect(recruiteeAdapter.mapItem({ ...RAW_OFFER, description: null }, ctx)?.descriptionText).toBe("");
    });
  });

  describe("title is passed through verbatim", () => {
    it("preserves the ATS casing and spacing of the title", () => {
      const job = recruiteeAdapter.mapItem({ ...RAW_OFFER, title: "  iOS  Engineer (Remote) " }, ctx);
      expect(job?.title).toBe("  iOS  Engineer (Remote) ");
    });
  });

  describe("returns null on malformed items (skip + count, never throw)", () => {
    it.each([
      ["non-record", 42],
      ["null", null],
      ["array", []],
      ["missing id", (() => { const { id, ...r } = RAW_OFFER; void id; return r; })()],
      ["string id", { ...RAW_OFFER, id: "482915" }],
      ["non-finite id", { ...RAW_OFFER, id: Number.NaN }],
      ["missing title", (() => { const { title, ...r } = RAW_OFFER; void title; return r; })()],
      ["non-string title", { ...RAW_OFFER, title: 123 }],
    ])("%s → null", (_label, raw) => {
      expect(recruiteeAdapter.mapItem(raw, ctx)).toBeNull();
    });
  });
});
