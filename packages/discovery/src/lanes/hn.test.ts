import { describe, expect, it } from "vitest";

import { fetchHnAlgoliaLane, parseHnThread, type HnItem } from "./hn";

// Leaf pure-unit port of scripts/test-lane-hn.ts. `parseHnThread` is the offline, network-free half of
// the HN "Who is hiring?" lane: it entity-decodes each comment's HTML (HN encodes `/` as `&#x2F;` and `&`
// as `&amp;`), regex-extracts http(s) URLs, strips trailing prose punctuation, keeps ONLY URLs a covered
// adapter claims (resolveUrl), and dedupes by the resolved (source, rawSlug). This suite locks that
// contract against a captured-shape /items tree plus hand-built punctuation/entity edge cases. The live
// `fetchHnAlgoliaLane` check is gated behind HN_LIVE_TEST=1 (unit project has no MSW, so the opt-in fetch
// can reach the network).

describe("parseHnThread — offline captured fixture", () => {
  // Captured-shape /items tree (trimmed), copied VERBATIM from scripts/test-lane-hn.ts. URLs are HN-ENCODED
  // exactly as the Algolia API returns them — `/` as `&#x2F;` (so the parser MUST entity-decode before
  // matching) and `&` as `&amp;`. Mixes covered ATS boards (greenhouse/lever/ashby), an uncovered ATS
  // (bamboohr), a vanity homepage, a GitHub link, an href with &amp; in the query, a URL with trailing prose
  // punctuation, a nested reply, and a null node.
  const fixture: HnItem = {
    text: null,
    children: [
      {
        text: `Acme Corp | SF | Onsite<p>Apply: <a href="https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;acme" rel="nofollow">https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;acme</a>`,
        children: [],
      },
      {
        text: `Beta Inc | Remote<p>https:&#x2F;&#x2F;jobs.lever.co&#x2F;beta and our site https:&#x2F;&#x2F;beta.example.com.`,
        children: [{ text: `Reply: also https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;beta-labs!`, children: [] }],
      },
      {
        text: `Gamma | uses https:&#x2F;&#x2F;gamma.bamboohr.com&#x2F;careers (uncovered) and https:&#x2F;&#x2F;github.com&#x2F;gamma`,
        children: [],
      },
      { text: `Delta | <a href="https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;delta?token=a&amp;b=2">link</a>`, children: [] },
      {
        // HN auto-link: full href + a truncated display copy (…). Both resolve to lever:epsilon, so the
        // resolved-slug dedup collapses them onto the full href (first wins).
        text: `Epsilon | <a href="https:&#x2F;&#x2F;jobs.lever.co&#x2F;epsilon&#x2F;1234-5678-90ab" rel="nofollow">https:&#x2F;&#x2F;jobs.lever.co&#x2F;epsilon&#x2F;1234-5...</a>`,
        children: [],
      },
      // Bare board URL ending in an AUTHOR ellipsis (no full-href twin) — must be CLEANED, not dropped.
      // The trailing strip recovers greenhouse:zeta.
      { text: `Zeta | apply at https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;zeta...`, children: [] },
      { text: null, children: [] },
      { text: `no links here, just prose`, children: [] },
    ],
  };

  const records = parseHnThread(fixture);
  const links = records.flatMap((r) => r.ats_links ?? []).sort();

  it("extracts exactly the 6 covered board URLs (decoded), sorted", () => {
    expect(links).toStrictEqual([
      "https://boards.greenhouse.io/acme",
      "https://boards.greenhouse.io/delta?token=a&b=2",
      "https://boards.greenhouse.io/zeta",
      "https://jobs.ashbyhq.com/beta-labs",
      "https://jobs.lever.co/beta",
      "https://jobs.lever.co/epsilon/1234-5678-90ab",
    ]);
  });

  it("emits one CompanyRecord per hiring comment carrying a covered URL", () => {
    expect(records).toHaveLength(6);
  });

  it("skips the uncovered ATS (bamboohr), a GitHub link, and a vanity homepage", () => {
    expect(links.some((l) => l.includes("bamboohr"))).toBe(false);
    expect(links.some((l) => l.includes("github.com"))).toBe(false);
    expect(links.some((l) => l.includes("example.com"))).toBe(false);
  });

  it("decodes &amp; -> & preserving the greenhouse query (delta?token=a&b=2)", () => {
    expect(links).toContain("https://boards.greenhouse.io/delta?token=a&b=2");
  });

  it("strips a trailing '!' from the nested Ashby reply -> jobs.ashbyhq.com/beta-labs", () => {
    expect(links).toContain("https://jobs.ashbyhq.com/beta-labs");
  });

  it("keeps the zeta bare URL ending in '...' (cleaned, not dropped)", () => {
    expect(links).toContain("https://boards.greenhouse.io/zeta");
  });

  it("collapses the truncated Epsilon display copy onto the full href via resolved-slug dedup", () => {
    expect(links).toContain("https://jobs.lever.co/epsilon/1234-5678-90ab");
    expect(links.some((l) => l.includes("1234-5") && !l.endsWith("90ab"))).toBe(false);
  });

  it("returns [] for a null-text childless thread (no throw)", () => {
    expect(parseHnThread({ text: null, children: [] })).toStrictEqual([]);
  });

  it("returns [] for a missing-fields thread (no throw)", () => {
    expect(parseHnThread({})).toStrictEqual([]);
  });
});

describe("parseHnThread — punctuation / entity edge cases", () => {
  // Single-comment helper: the root text is collected too, so a one-node thread exercises the full pipeline.
  const linksOf = (text: string): string[] =>
    parseHnThread({ text, children: [] }).flatMap((r) => r.ats_links ?? []);

  // NOTE: every edge URL targets a REAL covered host (greenhouse / lever / ashby) — resolveUrl drops any
  // uncovered host, which would make the assertion vacuous.

  it.each([
    [`https://boards.greenhouse.io/foo!`, "https://boards.greenhouse.io/foo"],
    [`https://jobs.lever.co/bar!!!`, "https://jobs.lever.co/bar"],
    [`https://jobs.ashbyhq.com/baz?)`, "https://jobs.ashbyhq.com/baz"], // URL_RE stops at ')', then '?' stripped
    [`https://boards.greenhouse.io/qux).`, "https://boards.greenhouse.io/qux"], // URL_RE stops at ')'
  ])("strips trailing prose punctuation to recover the slug: %s", (text, expected) => {
    expect(linksOf(text)).toStrictEqual([expected]);
  });

  it("cleans + keeps a bare URL ending in ASCII '...'", () => {
    expect(linksOf(`https://boards.greenhouse.io/alpha...`)).toStrictEqual([
      "https://boards.greenhouse.io/alpha",
    ]);
  });

  it("cleans + keeps a bare URL ending in a unicode ellipsis", () => {
    // Build the ellipsis at runtime so the on-disk fixture byte is unambiguous.
    const ellipsis = String.fromCharCode(0x2026);
    expect(linksOf(`https://jobs.lever.co/omega${ellipsis}`)).toStrictEqual([
      "https://jobs.lever.co/omega",
    ]);
  });

  it.each([
    [`(https://boards.greenhouse.io/foo)`, "https://boards.greenhouse.io/foo"], // URL_RE stops at ')'
    [`[https://jobs.lever.co/bar]`, "https://jobs.lever.co/bar"], // URL_RE stops at ']'
  ])("unwraps a paren/bracket-wrapped URL: %s", (text, expected) => {
    expect(linksOf(text)).toStrictEqual([expected]);
  });

  it.each([
    [`see https://jobs.ashbyhq.com/qux</a> here`, "https://jobs.ashbyhq.com/qux"], // stops at '<'
    [`"https://boards.greenhouse.io/zed"`, "https://boards.greenhouse.io/zed"], // stops at '"'
  ])("stops before a following '</a>' or quote (no glue): %s", (text, expected) => {
    expect(linksOf(text)).toStrictEqual([expected]);
  });

  it.each([
    [`https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;hex`, "https://boards.greenhouse.io/hex"], // hex entity
    [`https:&#47;&#47;jobs.lever.co&#47;dec`, "https://jobs.lever.co/dec"], // decimal entity
  ])("decodes '&#x2F;'/'&#47;' to '//' and extracts the board: %s", (text, expected) => {
    expect(linksOf(text)).toStrictEqual([expected]);
  });

  it("dedupes two copies resolving to the same (source, rawSlug) to one link (first wins)", () => {
    const text = `apply https://jobs.lever.co/dupe/role-1 or again https://jobs.lever.co/dupe/role-2`;
    expect(linksOf(text)).toStrictEqual(["https://jobs.lever.co/dupe/role-1"]);
  });
});

// Opt-in LIVE check against the real current HN "Who is hiring?" thread (network; no creds). Two sequential
// fetches (each AbortSignal.timeout(10s)) validate the Algolia endpoints + title-filter + /items shape that
// the offline fixture can't. TOLERANT assertions only. Enable with HN_LIVE_TEST=1.
const HN_LIVE = process.env.HN_LIVE_TEST === "1";

describe.skipIf(!HN_LIVE)("fetchHnAlgoliaLane — live", () => {
  it(
    "resolves the current thread and yields > 0 covered-board records with http(s) links",
    async () => {
      const records = await fetchHnAlgoliaLane();
      expect(records.length).toBeGreaterThan(0);

      const links = records.flatMap((r) => r.ats_links ?? []);
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(link).toMatch(/^https?:\/\//);
      }
    },
    30_000,
  );
});
