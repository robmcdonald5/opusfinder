/**
 * Unit tests for the seed resolver: `resolveUrl` + `resolveSeed` over synthetic
 * records (offline, deterministic). Pass `--live` to ALSO fetch the pinned outscal seed and assert it
 * yields candidates > 0 (a network integration check). Run with
 * `pnpm --filter @opusfinder/discovery test:resolve`. node:assert/strict → non-zero exit on failure.
 */
import assert from "node:assert/strict";

import { resolveSeed, resolveUrl } from "../src/resolve";
import { loadSeed, type CompanyRecord } from "../src/seed";

assert.deepEqual(resolveUrl(new URL("https://boards.greenhouse.io/acme")), {
  source: "greenhouse",
  rawSlug: "acme",
});
assert.equal(
  resolveUrl(new URL("https://acme.bamboohr.com/careers")),
  null,
  "bamboohr → no adapter",
);
assert.equal(resolveUrl(new URL("https://www.cusmat.com/careers/")), null, "vanity → no adapter");

const records: CompanyRecord[] = [
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

const { candidates, counts } = resolveSeed(records);
assert.equal(counts.seedRecords, 4);
assert.equal(counts.atsLinks, 7);
assert.equal(counts.badUrl, 1, "one malformed URL");
assert.equal(counts.deferredNoAdapter, 2, "bamboohr + vanity careers page");
assert.equal(counts.invalidSlug, 1, "ashby %20 slug fails the floor");
assert.equal(counts.candidates, 2, "greenhouse + lever (duplicate greenhouse collapsed)");
assert.deepEqual(
  candidates.map((c) => `${c.source}:${c.slug}`),
  ["greenhouse:acme", "lever:acme"],
);
assert.equal(candidates[0]?.sourceUrl, "https://boards.greenhouse.io/acme", "provenance kept");

// --source scopes to one source, skipping other-source links BEFORE normalize (so the ashby
// link is filtered out, not counted as invalidSlug).
const scoped = resolveSeed(records, { source: "greenhouse" });
assert.equal(scoped.counts.candidates, 1, "only greenhouse candidate");
assert.equal(scoped.counts.invalidSlug, 0, "ashby link filtered before normalize");
assert.equal(scoped.candidates[0]?.source, "greenhouse");

console.log("resolve: offline assertions passed.");

if (process.argv.includes("--live")) {
  const live = await loadSeed();
  const resolved = resolveSeed(live);
  console.log("live seed counts:", resolved.counts);
  assert.ok(
    resolved.counts.seedRecords > 1000,
    `expected the full seed, got ${resolved.counts.seedRecords}`,
  );
  assert.ok(resolved.counts.candidates > 0, "pinned seed yields > 0 candidates");
  const bySource = new Set(resolved.candidates.map((c) => c.source));
  console.log("sources represented:", [...bySource].sort().join(", "));
  console.log("resolve: live assertions passed.");
}
