import { describe, expect, it } from "vitest";

import { resolveSeed, resolveUrl, type ResolveCounts } from "./resolve";
import type { CompanyRecord } from "./seed";

// Leaf pure-unit for the seed resolver (offline, deterministic — no timers, no network). Ports
// scripts/test-resolve.ts. `resolveUrl` is URL → (source, rawSlug) by first-matching adapter;
// `resolveSeed` folds seed records into a deduped Candidate[] while tallying every drop (badUrl /
// deferredNoAdapter / invalidSlug). The synthetic fixture is copied VERBATIM from the smoke.

/**
 * The smoke's synthetic records, frozen so a test can't mutate shared fixture state. `resolveSeed`
 * only reads these, so an in-place freeze is safe and keeps the declared `CompanyRecord[]` type.
 */
const SYNTHETIC_RECORDS: CompanyRecord[] = [
  {
    name: "Acme",
    ats_links: [
      "https://boards.greenhouse.io/acme", // → greenhouse:acme
      "https://jobs.lever.co/acme", // → lever:acme
      "not a url", // badUrl
      "https://jobs.ashbyhq.com/Pocket%20Worlds", // invalidSlug (% fails the floor)
      "https://acme.bamboohr.com/careers", // deferredNoAdapter
      "https://boards.greenhouse.io/acme", // dup → collapsed
    ],
  },
  { name: "Empty", ats_links: [] },
  { name: "NoField" },
  { name: "Vanity", ats_links: ["https://www.cusmat.com/careers/"] }, // deferredNoAdapter
];
Object.freeze(SYNTHETIC_RECORDS);

describe("resolveUrl — URL → (source, rawSlug) by first-matching adapter", () => {
  it("greenhouse board host → greenhouse:acme (pre-normalize raw slug)", () => {
    expect(resolveUrl(new URL("https://boards.greenhouse.io/acme"))).toEqual({
      source: "greenhouse",
      rawSlug: "acme",
    });
  });

  it("bamboohr (unsupported ATS) → null", () => {
    expect(resolveUrl(new URL("https://acme.bamboohr.com/careers"))).toBeNull();
  });

  it("vanity careers page → null", () => {
    expect(resolveUrl(new URL("https://www.cusmat.com/careers/"))).toBeNull();
  });
});

describe("resolveSeed — dedup + drop tally over synthetic records", () => {
  it("tallies every bucket and collapses the duplicate greenhouse link", () => {
    const { candidates, counts } = resolveSeed(SYNTHETIC_RECORDS);

    // The whole counts object at once (non-string/empty/whitespace links are skipped WITHOUT
    // incrementing atsLinks; the two greenhouse links dedupe to one candidate).
    const expected: ResolveCounts = {
      seedRecords: 4,
      atsLinks: 7,
      badUrl: 1, // "not a url"
      deferredNoAdapter: 2, // bamboohr + vanity careers page
      invalidSlug: 1, // ashby "Pocket%20Worlds" (% fails the floor)
      candidates: 2, // greenhouse:acme + lever:acme (dup greenhouse collapsed)
    };
    expect(counts).toEqual(expected);

    // Identity AND order: the dedup key is JSON.stringify([source, slug]).
    expect(candidates.map((c) => `${c.source}:${c.slug}`)).toEqual([
      "greenhouse:acme",
      "lever:acme",
    ]);

    // Provenance: the first candidate keeps the original seed URL string.
    expect(candidates[0]!.sourceUrl).toBe("https://boards.greenhouse.io/acme");
  });

  it("opts.source scopes to one source, filtering other-source links BEFORE normalize", () => {
    const { candidates, counts } = resolveSeed(SYNTHETIC_RECORDS, { source: "greenhouse" });

    expect(counts.candidates).toBe(1);
    // The ashby link is skipped for being off-source, so it is never normalized → not counted.
    expect(counts.invalidSlug).toBe(0);
    expect(candidates[0]!.source).toBe("greenhouse");
  });

  it("skips non-string / empty / whitespace-only links BEFORE counting atsLinks", () => {
    // The guard (`typeof link !== "string" || link.trim() === ""`) runs before the atsLinks++ — so
    // blanks/non-strings are neither counted nor passed to `new URL()` (they never become badUrl).
    const { candidates, counts } = resolveSeed([
      {
        name: "Blanks",
        ats_links: ["", "   ", 123 as unknown as string, "https://boards.greenhouse.io/keeper"],
      },
    ]);
    expect(counts.atsLinks).toBe(1); // only the one real link is counted
    expect(counts.badUrl).toBe(0); // blanks skipped before new URL(), so no parse failure
    expect(counts.candidates).toBe(1);
    expect(candidates.map((c) => `${c.source}:${c.slug}`)).toEqual(["greenhouse:keeper"]);
  });
});

// The universal floor is SLUG_RE=/^[A-Za-z0-9._-]+$/ (in @opusfinder/shared): non-empty,
// whitespace-free, URL-path-safe, NO length cap and NO percent-decoding.
describe("slug floor boundaries", () => {
  it("a unicode slug is percent-encoded by new URL() (NOT decoded), so '%' fails the floor", () => {
    // new URL() encodes "café" → "caf%C3%A9"; the raw slug carries the literal '%' verbatim.
    expect(resolveUrl(new URL("https://boards.greenhouse.io/café"))).toEqual({
      source: "greenhouse",
      rawSlug: "caf%C3%A9",
    });

    const { counts } = resolveSeed([
      { name: "Unicode", ats_links: ["https://boards.greenhouse.io/café"] },
    ]);
    expect(counts.atsLinks).toBe(1);
    expect(counts.invalidSlug).toBe(1);
    expect(counts.candidates).toBe(0);
  });

  it("a very long all-ASCII slug is ACCEPTED — the floor has no length cap", () => {
    const longSlug = "a".repeat(300);
    const { candidates, counts } = resolveSeed([
      { name: "Long", ats_links: [`https://boards.greenhouse.io/${longSlug}`] },
    ]);

    expect(counts.invalidSlug).toBe(0);
    expect(counts.candidates).toBe(1);
    expect(candidates.map((c) => `${c.source}:${c.slug}`)).toEqual([`greenhouse:${longSlug}`]);
  });
});
