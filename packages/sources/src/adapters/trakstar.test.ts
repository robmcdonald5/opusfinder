import { companySlug } from "@opusfinder/shared";
import { describe, expect, it } from "vitest";

import { trakstarAdapter } from "./trakstar";
import type { SourceContext } from "./types";

// Leaf pure-unit for the Trakstar Hire (Recruiterbox) mapper (trakstarAdapter.mapItem). The
// normalization here is the load-bearing contract: a raw `/v1/openings/` object → a fully-valid
// NormalizedJob, with the quirks that would silently corrupt output if they regressed — the
// already-string `id` (rejected when empty/whitespace, branded once and REUSED in the reconstructed
// apply URL), the structured `allows_remote` tri-state where BOTH true and false are authoritative
// (an explicit non-remote must not be overridden by location text), the `location` OBJECT composed
// from city/state/country (zipcode dropped), and the deliberate `postedAt: null` because Trakstar
// exposes only `close_date` (an EXPIRY date) that must NEVER be treated as a posted date. Frozen
// fixtures so a regression in any of those shows up here.

// ctx is the branded slug the caller produced via normalizeSlug; companySlug is NOT applied again in
// the mapper, so `companySlug` on the output must echo ctx.slug verbatim (the lowercased subdomain
// also feeds the reconstructed apply URL).
const ctx: SourceContext = { slug: companySlug("acme"), rawSlug: "ACME" };

/** A complete, realistic Recruiterbox opening — the shape every field-by-field assertion derives from. */
const RAW_OPENING = Object.freeze({
  id: "fk0745",
  title: "Senior Backend Engineer",
  hosted_url: "https://acme.hire.trakstar.com/jobs/fk0745/",
  description: "<p>Build <strong>great</strong> things &amp; ship daily.</p>",
  allows_remote: true,
  location: Object.freeze({
    city: "Austin",
    state: "Texas",
    country: "United States",
    zipcode: "78701",
  }),
  close_date: "2026-08-01",
});

describe("trakstarAdapter.mapItem", () => {
  it("maps a full opening field-by-field into the normalized shape", () => {
    const job = trakstarAdapter.mapItem(RAW_OPENING, ctx);

    expect(job).toEqual({
      source: "trakstar",
      externalId: "fk0745", // already a string — no stringify
      title: "Senior Backend Engineer",
      companySlug: "acme",
      locations: ["Austin, Texas, United States"], // zipcode intentionally dropped
      remote: true,
      descriptionText: "Build great things & ship daily.",
      applyUrl: "https://acme.hire.trakstar.com/jobs/fk0745/",
      postedAt: null, // close_date is an EXPIRY date and must NOT be used
      raw: RAW_OPENING,
    });
  });

  it("keeps the original raw object by reference for reprocessing", () => {
    const job = trakstarAdapter.mapItem(RAW_OPENING, ctx);
    expect(job?.raw).toBe(RAW_OPENING);
  });

  describe("apply URL fallback", () => {
    it("prefers hosted_url when present", () => {
      const job = trakstarAdapter.mapItem(
        { ...RAW_OPENING, hosted_url: "https://apply.example/x" },
        ctx,
      );
      expect(job?.applyUrl).toBe("https://apply.example/x");
    });

    it("reconstructs from the lowercased slug + branded id when hosted_url is empty", () => {
      const job = trakstarAdapter.mapItem({ ...RAW_OPENING, hosted_url: "" }, ctx);
      expect(job?.applyUrl).toBe("https://acme.hire.trakstar.com/jobs/fk0745/");
    });

    it("reconstructs when hosted_url is missing", () => {
      const { hosted_url, ...rest } = RAW_OPENING;
      void hosted_url;
      const job = trakstarAdapter.mapItem(rest, ctx);
      expect(job?.applyUrl).toBe("https://acme.hire.trakstar.com/jobs/fk0745/");
    });

    it("reconstructs using the TRIMMED id (branded once, reused) so the URL never carries padding", () => {
      const job = trakstarAdapter.mapItem(
        { ...RAW_OPENING, id: "  fk0745  ", hosted_url: "" },
        ctx,
      );
      expect(job?.externalId).toBe("fk0745");
      expect(job?.applyUrl).toBe("https://acme.hire.trakstar.com/jobs/fk0745/");
    });
  });

  describe("remote resolution — allows_remote tri-state", () => {
    it("allows_remote:true is authoritative even with a non-remote location", () => {
      const job = trakstarAdapter.mapItem({ ...RAW_OPENING, allows_remote: true }, ctx);
      expect(job?.remote).toBe(true);
    });

    it("allows_remote:false overrides a 'Remote' location string (structured wins over inference)", () => {
      const job = trakstarAdapter.mapItem(
        { ...RAW_OPENING, allows_remote: false, location: { city: "Remote", country: "United States" } },
        ctx,
      );
      expect(job?.remote).toBe(false);
    });

    it("allows_remote:null → infers true from a 'Remote' location string", () => {
      const job = trakstarAdapter.mapItem(
        { ...RAW_OPENING, allows_remote: null, location: { city: "Remote", country: "United States" } },
        ctx,
      );
      expect(job?.remote).toBe(true);
    });

    it("allows_remote:null + non-remote location → false", () => {
      const job = trakstarAdapter.mapItem({ ...RAW_OPENING, allows_remote: null }, ctx);
      expect(job?.remote).toBe(false);
    });

    it("allows_remote missing → infers from text (true here)", () => {
      const { allows_remote, ...rest } = RAW_OPENING;
      void allows_remote;
      const job = trakstarAdapter.mapItem(
        { ...rest, location: { city: "Remote", country: "United States" } },
        ctx,
      );
      expect(job?.remote).toBe(true);
    });

    it("a non-boolean truthy allows_remote ('true') is NOT authoritative — falls through to inference", () => {
      const job = trakstarAdapter.mapItem({ ...RAW_OPENING, allows_remote: "true" }, ctx);
      // location text is "Austin, Texas, United States" → no word-boundary "remote" → false
      expect(job?.remote).toBe(false);
    });
  });

  describe("location extraction from the location OBJECT", () => {
    it("composes city/state/country with ', ' and drops zipcode", () => {
      const job = trakstarAdapter.mapItem(RAW_OPENING, ctx);
      expect(job?.locations).toEqual(["Austin, Texas, United States"]);
    });

    it("skips blank and non-string parts, trimming the survivors", () => {
      const job = trakstarAdapter.mapItem(
        { ...RAW_OPENING, location: { city: "  London ", state: "   ", country: 44 } },
        ctx,
      );
      expect(job?.locations).toEqual(["London"]);
    });

    it("composes from a single present part", () => {
      const job = trakstarAdapter.mapItem(
        { ...RAW_OPENING, location: { country: "Canada" } },
        ctx,
      );
      expect(job?.locations).toEqual(["Canada"]);
    });

    it("returns [] when the location object is all-empty", () => {
      const job = trakstarAdapter.mapItem(
        { ...RAW_OPENING, location: { city: "", state: "", country: "" } },
        ctx,
      );
      expect(job?.locations).toEqual([]);
    });

    it.each([
      ["missing", undefined],
      ["null", null],
      ["non-object", "Austin, TX"],
      ["array", []],
    ])("returns [] when location is %s", (_label, value) => {
      const job = trakstarAdapter.mapItem({ ...RAW_OPENING, location: value }, ctx);
      expect(job?.locations).toEqual([]);
    });
  });

  describe("postedAt is always null", () => {
    it("never derives a date even when close_date is present", () => {
      const job = trakstarAdapter.mapItem({ ...RAW_OPENING, close_date: "2026-12-31" }, ctx);
      expect(job?.postedAt).toBeNull();
    });

    it("is null when close_date is absent", () => {
      const { close_date, ...rest } = RAW_OPENING;
      void close_date;
      expect(trakstarAdapter.mapItem(rest, ctx)?.postedAt).toBeNull();
    });
  });

  describe("descriptionText", () => {
    it("strips tags, decodes one entity layer, and collapses whitespace", () => {
      const job = trakstarAdapter.mapItem(
        { ...RAW_OPENING, description: "<p>Hello&nbsp;&amp; <b>welcome</b></p>" },
        ctx,
      );
      expect(job?.descriptionText).toBe("Hello & welcome");
    });

    it("is '' when description is missing, empty, or non-string", () => {
      const { description, ...rest } = RAW_OPENING;
      void description;
      expect(trakstarAdapter.mapItem(rest, ctx)?.descriptionText).toBe("");
      expect(trakstarAdapter.mapItem({ ...RAW_OPENING, description: "" }, ctx)?.descriptionText).toBe("");
      expect(trakstarAdapter.mapItem({ ...RAW_OPENING, description: null }, ctx)?.descriptionText).toBe("");
    });
  });

  describe("title is passed through verbatim", () => {
    it("preserves the ATS casing and spacing of the title (no normalization)", () => {
      const job = trakstarAdapter.mapItem({ ...RAW_OPENING, title: "  iOS  Engineer (Remote) " }, ctx);
      expect(job?.title).toBe("  iOS  Engineer (Remote) ");
    });
  });

  describe("returns null on malformed items (skip + count, never throw)", () => {
    it.each([
      ["non-record number", 42],
      ["null", null],
      ["array", []],
      ["missing id", (() => { const { id, ...r } = RAW_OPENING; void id; return r; })()],
      ["non-string id", { ...RAW_OPENING, id: 745 }],
      ["empty id", { ...RAW_OPENING, id: "" }],
      ["whitespace-only id", { ...RAW_OPENING, id: "   " }],
      ["missing title", (() => { const { title, ...r } = RAW_OPENING; void title; return r; })()],
      ["non-string title", { ...RAW_OPENING, title: 123 }],
    ])("%s → null", (_label, raw) => {
      expect(trakstarAdapter.mapItem(raw, ctx)).toBeNull();
    });

    // interior-whitespace id → skip (null), never throw — mapItem contract; regression for the jobId throw.
    it("skips an interior-whitespace id without throwing", () => {
      expect(() => trakstarAdapter.mapItem({ ...RAW_OPENING, id: "ab cd" }, ctx)).not.toThrow();
      expect(trakstarAdapter.mapItem({ ...RAW_OPENING, id: "ab cd" }, ctx)).toBeNull();
    });
  });
});

describe("trakstarAdapter.normalizeSlug", () => {
  // The host is case-insensitive and echoes client_name lowercased, so the canonical slug must
  // lowercase before the universal floor brands it — otherwise apply-URL reconstruction diverges.
  it.each([
    ["Acme-Corp", "acme-corp"],
    ["ACME", "acme"],
    ["MixedCase_Slug.io", "mixedcase_slug.io"],
    ["  PadMe  ", "padme"],
  ])("lowercases %j → %j", (input, expected) => {
    expect(trakstarAdapter.normalizeSlug(input)).toBe(expected);
  });
});
