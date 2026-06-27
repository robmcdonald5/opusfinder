/**
 * Unit tests for the HN/Algolia lane PARSER (`parseHnThread`) over a captured-shape Algolia /items
 * payload — offline, deterministic, no network. Asserts the parser: extracts covered ATS board URLs into
 * ats_links (one CompanyRecord per hiring comment that carries ≥1 covered URL); SKIPS non-ATS links
 * (homepages, GitHub) and uncovered ATSes (BambooHR); decodes the `&amp;` HN emits in hrefs; strips
 * trailing prose punctuation; and is robust to null/empty comment text. Run with
 * `pnpm --filter @opusfinder/discovery test:lane-hn`. node:assert/strict → non-zero exit on failure.
 */
import assert from "node:assert/strict";

import { fetchHnAlgoliaLane, parseHnThread, type HnItem } from "../src/lanes/hn";

// Captured-shape /items tree (trimmed). URLs are HN-ENCODED exactly as the Algolia API returns them —
// `/` as `&#x2F;` (so the parser MUST entity-decode before matching) and `&` as `&amp;`. Mixes covered ATS
// boards (greenhouse/lever/ashby), an uncovered ATS (bamboohr), a vanity homepage, a GitHub link, an href
// with &amp; in the query, a URL with trailing prose punctuation, a nested reply, and a null node.
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

assert.deepEqual(
  links,
  [
    "https://boards.greenhouse.io/acme",
    "https://boards.greenhouse.io/delta?token=a&b=2",
    "https://boards.greenhouse.io/zeta",
    "https://jobs.ashbyhq.com/beta-labs",
    "https://jobs.lever.co/beta",
    "https://jobs.lever.co/epsilon/1234-5678-90ab",
  ],
  "covered boards extracted (decoded); bamboohr + github + vanity homepage skipped",
);
assert.equal(records.length, 6, "one CompanyRecord per hiring comment carrying a covered URL");
assert.ok(links.includes("https://boards.greenhouse.io/delta?token=a&b=2"), "&amp; decoded to & in the href");
assert.ok(links.includes("https://jobs.ashbyhq.com/beta-labs"), "trailing '!' stripped from the reply URL");
assert.ok(
  links.includes("https://boards.greenhouse.io/zeta"),
  "author-trailing-ellipsis bare URL is cleaned + kept, not dropped (the prior `...`-skip regression)",
);
assert.ok(
  !links.some((l) => l.includes("1234-5") && !l.endsWith("90ab")),
  "the truncated display copy of the Epsilon URL collapses onto the full href via resolved-slug dedup",
);

// Robustness: an empty / childless tree yields no records, never throws.
assert.deepEqual(parseHnThread({ text: null, children: [] }), [], "empty thread → no records");
assert.deepEqual(parseHnThread({}), [], "missing fields → no records");

console.log("lane-hn: offline fixture assertions passed.");

// --- opt-in LIVE check against the real current HN "Who is hiring?" thread (network; no creds) ---
// Validates the Algolia endpoints + the title-filter heuristic + the /items tree shape end-to-end —
// the things the offline fixture can't. Run: `pnpm --filter @opusfinder/discovery exec tsx scripts/test-lane-hn.ts --live`.
if (process.argv.includes("--live")) {
  const live = await fetchHnAlgoliaLane();
  const liveLinks = live.flatMap((r) => r.ats_links ?? []);
  console.log(`live HN thread: ${live.length} records, ${liveLinks.length} covered board URLs`);
  console.log("sample:", liveLinks.slice(0, 8));
  assert.ok(live.length > 0, "the current HN Who-is-Hiring thread yields > 0 covered-board records");
  console.log("lane-hn: live assertions passed.");
}
