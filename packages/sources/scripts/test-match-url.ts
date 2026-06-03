/**
 * Unit tests for the Phase-7 descriptor additions: each adapter's `matchUrl` (the URL→raw-slug
 * inverse of `jobsRequest`) and the `classifyProbe` overrides on SmartRecruiters + Trakstar. Pure,
 * no network/DB. Run with `pnpm --filter @opusfinder/sources test:match`. A tsx assertion script
 * rather than a test framework (same call as eval's test-metrics): node:assert/strict gives a
 * non-zero exit on failure, which is all CI needs.
 */
import assert from "node:assert/strict";

import type { SourceName } from "@opusfinder/shared";

import { adapters, SOURCE_NAMES } from "../src/adapters";
import type { ProbeOutcome } from "../src/adapters/types";

/** Assert `source`.matchUrl(url) === expected. */
function eq(source: SourceName, url: string, expected: string | null): void {
  const got = adapters[source].matchUrl(new URL(url));
  assert.equal(
    got,
    expected,
    `${source}.matchUrl(${url}) → ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`,
  );
}

/** Assert `source` matches `url` to `expected` AND no OTHER adapter matches it (disjoint hosts). */
function only(source: SourceName, url: string, expected: string): void {
  eq(source, url, expected);
  for (const other of SOURCE_NAMES) {
    if (other === source) continue;
    assert.equal(
      adapters[other].matchUrl(new URL(url)),
      null,
      `${other}.matchUrl should NOT claim ${url} (owned by ${source})`,
    );
  }
}

const classify = (source: SourceName, status: number, body: unknown): ProbeOutcome | undefined =>
  adapters[source].classifyProbe?.(status, body);

// --- greenhouse: 4 public board hosts (first path segment) + the boards-API host -----------
only("greenhouse", "https://boards.greenhouse.io/vercel", "vercel");
only("greenhouse", "https://job-boards.greenhouse.io/vercel", "vercel");
only("greenhouse", "https://boards.eu.greenhouse.io/acme", "acme");
only("greenhouse", "https://job-boards.eu.greenhouse.io/acme", "acme");
eq("greenhouse", "https://boards.greenhouse.io/vercel/jobs/123", "vercel"); // first segment only
eq("greenhouse", "https://boards-api.greenhouse.io/v1/boards/vercel/jobs?content=true", "vercel");
eq("greenhouse", "https://boards.greenhouse.io/", null); // bare host → no slug
eq("greenhouse", "https://example.com/vercel", null); // foreign host

// --- lever: jobs.lever.co + api.lever.co; EU hosts are deliberately unmatched --------------
only("lever", "https://jobs.lever.co/leverdemo", "leverdemo");
eq("lever", "https://api.lever.co/v0/postings/leverdemo?mode=json", "leverdemo");
eq("lever", "https://jobs.eu.lever.co/acme", null); // EU → null (US-only probe)
eq("lever", "https://api.eu.lever.co/v0/postings/acme", null); // EU → null
eq("lever", "https://example.com/leverdemo", null);

// --- ashby: case-PRESERVED slug ------------------------------------------------------------
only("ashby", "https://jobs.ashbyhq.com/Notion", "Notion");
eq(
  "ashby",
  "https://api.ashbyhq.com/posting-api/job-board/Notion?includeCompensation=true",
  "Notion",
);
eq("ashby", "https://example.com/Notion", null);

// --- workable: widget-API path, bare /{slug}, reserved tokens, query stripped ---------------
only("workable", "https://apply.workable.com/fuku", "fuku");
eq("workable", "https://apply.workable.com/fuku?lng=en", "fuku"); // query ignored
eq("workable", "https://apply.workable.com/api/v1/widget/accounts/fuku?details=true", "fuku");
eq("workable", "https://apply.workable.com/j/ABC123", null); // /j/ short link → not a slug
eq("workable", "https://apply.workable.com/jobs", null); // reserved alias
eq("workable", "https://example.com/fuku", null);

// --- smartrecruiters: jobs + careers public hosts + the api host ----------------------------
only("smartrecruiters", "https://jobs.smartrecruiters.com/Visa", "Visa");
eq("smartrecruiters", "https://careers.smartrecruiters.com/Visa", "Visa");
eq(
  "smartrecruiters",
  "https://api.smartrecruiters.com/v1/companies/Visa/postings?limit=100",
  "Visa",
);
eq("smartrecruiters", "https://example.com/Visa", null);

// --- recruitee + pinpoint: subdomain label; the bare base host has no tenant -----------------
only("recruitee", "https://xite.recruitee.com/", "xite");
eq("recruitee", "https://xite.recruitee.com/o/some-job", "xite");
eq("recruitee", "https://recruitee.com/", null); // no sub-domain
eq("recruitee", "https://www.recruitee.com/customers", null); // reserved infra subdomain, not a tenant
eq("recruitee", "https://support.recruitee.com/", null); // reserved
eq("recruitee", "https://example.com/", null);
only("pinpoint", "https://workwithus.pinpointhq.com/postings.json", "workwithus");
eq("pinpoint", "https://pinpointhq.com/", null);
eq("pinpoint", "https://www.pinpointhq.com/", null); // reserved
eq("pinpoint", "https://app.pinpointhq.com/login", null); // reserved

// --- gem: gem.com hosts only — NOT the Greenhouse-shaped apply URL --------------------------
only("gem", "https://jobs.gem.com/gem", "gem");
eq("gem", "https://api.gem.com/job_board/v0/gem/job_posts/", "gem");
eq("gem", "https://boards.greenhouse.io/gem", null); // greenhouse-shaped → greenhouse owns it, not gem
eq("gem", "https://example.com/gem", null);

// --- trakstar: jsapi query param + two subdomain forms; jsapi without the param → null ------
only("trakstar", "https://jsapi.recruiterbox.com/v1/openings/?client_name=instacart", "instacart");
only("trakstar", "https://instacart.hire.trakstar.com/", "instacart");
only("trakstar", "https://instacart.recruiterbox.com/", "instacart");
eq("trakstar", "https://jsapi.recruiterbox.com/v1/openings/", null); // no client_name → null, not "jsapi"
eq("trakstar", "https://jsapi.recruiterbox.com/v1/openings/?client_name=", null); // empty client_name → null
eq("trakstar", "https://cdn.recruiterbox.com/asset.js", null); // reserved infra subdomain, not a tenant
eq("trakstar", "https://example.com/", null);

// --- classifyProbe: only SmartRecruiters + Trakstar override; the other 7 omit it -----------
for (const s of SOURCE_NAMES) {
  const overrides = adapters[s].classifyProbe !== undefined;
  assert.equal(
    overrides,
    s === "smartrecruiters" || s === "trakstar",
    `${s} classifyProbe presence (expected only smartrecruiters + trakstar)`,
  );
}

// SmartRecruiters: 200+totalFound>0 = live; 200+totalFound:0 = indeterminate (unassertable); else indeterminate.
assert.equal(classify("smartrecruiters", 200, { totalFound: 5, content: [] }), "live", "SR live");
assert.equal(
  classify("smartrecruiters", 200, { totalFound: 0 }),
  "indeterminate",
  "SR empty=indeterminate",
);
assert.equal(classify("smartrecruiters", 404, undefined), "indeterminate", "SR 404=indeterminate");
assert.equal(
  classify("smartrecruiters", 200, "not-json"),
  "indeterminate",
  "SR non-record=indeterminate",
);

// Trakstar: 400=absent; 200 counts on meta.total; 404=absent; other=indeterminate.
assert.equal(classify("trakstar", 400, undefined), "absent", "Trakstar 400=absent");
assert.equal(
  classify("trakstar", 200, { meta: { total: 3 }, objects: [] }),
  "live",
  "Trakstar live",
);
assert.equal(
  classify("trakstar", 200, { meta: { total: 0 }, objects: [] }),
  "live-empty",
  "Trakstar empty",
);
assert.equal(classify("trakstar", 404, undefined), "absent", "Trakstar 404=absent");
assert.equal(classify("trakstar", 500, undefined), "indeterminate", "Trakstar 5xx=indeterminate");

console.log("matchUrl + classifyProbe: all assertions passed.");
