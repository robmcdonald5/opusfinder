import { describe, expect, it } from "vitest";

import type { SourceName } from "@opusfinder/shared";

import { adapters, SOURCE_NAMES } from "./index";
import type { ProbeOutcome } from "./types";

// Leaf pure-unit (no network/DB). Each adapter's `matchUrl` is the URL→raw-slug inverse of
// `jobsRequest`: it's what turns a seed `ats_links` URL back into a tenant slug to probe/upsert.
// Two load-bearing properties are locked here: (1) per-adapter routing — the right hosts/paths
// yield the right slug and every foreign/bare/reserved shape returns `null` (a wrong slug would
// probe/upsert a phantom tenant); (2) ownership is DISJOINT — exactly one adapter claims a given
// URL, so two adapters can't both ingest the same board. Also pins `classifyProbe` (only
// SmartRecruiters + Trakstar override it). Ports scripts/test-match-url.ts to reporter-owned `it.each`.

/** `source.matchUrl(url)` under the reporter. */
const matchUrl = (source: SourceName, url: string): string | null =>
  adapters[source].matchUrl(new URL(url));

const classify = (source: SourceName, status: number, body: unknown): ProbeOutcome | undefined =>
  adapters[source].classifyProbe?.(status, body);

describe("matchUrl — per-adapter URL → raw-slug routing", () => {
  // greenhouse: 4 public board hosts (first path segment) + the boards-API host.
  describe("greenhouse", () => {
    it.each([
      ["https://boards.greenhouse.io/vercel", "vercel"],
      ["https://job-boards.greenhouse.io/vercel", "vercel"],
      ["https://boards.eu.greenhouse.io/acme", "acme"],
      ["https://job-boards.eu.greenhouse.io/acme", "acme"],
      ["https://boards.greenhouse.io/vercel/jobs/123", "vercel"], // first segment only
      ["https://boards-api.greenhouse.io/v1/boards/vercel/jobs?content=true", "vercel"],
      // A board literally slugged "boards": segmentAfter anchors on the FIRST "boards" marker, so
      // the tenant is the next segment — `lastIndexOf` would wrongly return the segment after the slug.
      ["https://boards-api.greenhouse.io/v1/boards/boards/jobs?content=true", "boards"],
    ])("%s → %j", (url, slug) => {
      expect(matchUrl("greenhouse", url)).toBe(slug);
    });

    it.each([
      ["https://boards.greenhouse.io/", null], // bare host → no slug
      ["https://example.com/vercel", null], // foreign host
    ])("%s → %j", (url, slug) => {
      expect(matchUrl("greenhouse", url)).toBe(slug);
    });
  });

  // lever: jobs.lever.co + api.lever.co; EU hosts are deliberately unmatched (US-only probe).
  describe("lever", () => {
    it.each([
      ["https://jobs.lever.co/leverdemo", "leverdemo"],
      ["https://api.lever.co/v0/postings/leverdemo?mode=json", "leverdemo"],
    ])("%s → %j", (url, slug) => {
      expect(matchUrl("lever", url)).toBe(slug);
    });

    it.each([
      ["https://jobs.eu.lever.co/acme", null], // EU → null
      ["https://api.eu.lever.co/v0/postings/acme", null], // EU → null
      ["https://example.com/leverdemo", null],
    ])("%s → %j", (url, slug) => {
      expect(matchUrl("lever", url)).toBe(slug);
    });
  });

  // ashby: case-PRESERVED slug.
  describe("ashby", () => {
    it.each([
      ["https://jobs.ashbyhq.com/Notion", "Notion"],
      ["https://api.ashbyhq.com/posting-api/job-board/Notion?includeCompensation=true", "Notion"],
    ])("%s → %j", (url, slug) => {
      expect(matchUrl("ashby", url)).toBe(slug);
    });

    it("foreign host → null", () => {
      expect(matchUrl("ashby", "https://example.com/Notion")).toBeNull();
    });
  });

  // workable: widget-API path, bare /{slug}, reserved tokens, query stripped.
  describe("workable", () => {
    it.each([
      ["https://apply.workable.com/fuku", "fuku"],
      ["https://apply.workable.com/fuku?lng=en", "fuku"], // query ignored
      ["https://apply.workable.com/api/v1/widget/accounts/fuku?details=true", "fuku"],
    ])("%s → %j", (url, slug) => {
      expect(matchUrl("workable", url)).toBe(slug);
    });

    it.each([
      ["https://apply.workable.com/j/ABC123", null], // /j/ short link → not a slug
      ["https://apply.workable.com/jobs", null], // reserved alias
      ["https://apply.workable.com/", null], // bare host, empty path → no slug
      ["https://example.com/fuku", null],
    ])("%s → %j", (url, slug) => {
      expect(matchUrl("workable", url)).toBe(slug);
    });
  });

  // smartrecruiters: jobs + careers public hosts + the api host.
  describe("smartrecruiters", () => {
    it.each([
      ["https://jobs.smartrecruiters.com/Visa", "Visa"],
      ["https://careers.smartrecruiters.com/Visa", "Visa"],
      ["https://api.smartrecruiters.com/v1/companies/Visa/postings?limit=100", "Visa"],
    ])("%s → %j", (url, slug) => {
      expect(matchUrl("smartrecruiters", url)).toBe(slug);
    });

    it("foreign host → null", () => {
      expect(matchUrl("smartrecruiters", "https://example.com/Visa")).toBeNull();
    });
  });

  // recruitee: subdomain label; the bare/reserved-infra hosts have no tenant.
  describe("recruitee", () => {
    it.each([
      ["https://xite.recruitee.com/", "xite"],
      ["https://xite.recruitee.com/o/some-job", "xite"],
    ])("%s → %j", (url, slug) => {
      expect(matchUrl("recruitee", url)).toBe(slug);
    });

    it.each([
      ["https://recruitee.com/", null], // no sub-domain
      ["https://www.recruitee.com/customers", null], // reserved infra subdomain
      ["https://support.recruitee.com/", null], // reserved
      ["https://example.com/", null],
    ])("%s → %j", (url, slug) => {
      expect(matchUrl("recruitee", url)).toBe(slug);
    });
  });

  // pinpoint: subdomain label; reserved infra subdomains have no tenant.
  describe("pinpoint", () => {
    it("workwithus.pinpointhq.com → workwithus", () => {
      expect(matchUrl("pinpoint", "https://workwithus.pinpointhq.com/postings.json")).toBe(
        "workwithus",
      );
    });

    it.each([
      ["https://pinpointhq.com/", null], // no sub-domain
      ["https://www.pinpointhq.com/", null], // reserved
      ["https://app.pinpointhq.com/login", null], // reserved
    ])("%s → %j", (url, slug) => {
      expect(matchUrl("pinpoint", url)).toBe(slug);
    });
  });

  // gem: gem.com hosts only — NOT the Greenhouse-shaped apply URL.
  describe("gem", () => {
    it.each([
      ["https://jobs.gem.com/gem", "gem"],
      ["https://api.gem.com/job_board/v0/gem/job_posts/", "gem"],
    ])("%s → %j", (url, slug) => {
      expect(matchUrl("gem", url)).toBe(slug);
    });

    it.each([
      ["https://boards.greenhouse.io/gem", null], // greenhouse-shaped → greenhouse owns it, not gem
      ["https://example.com/gem", null],
    ])("%s → %j", (url, slug) => {
      expect(matchUrl("gem", url)).toBe(slug);
    });
  });

  // trakstar: jsapi query param + two subdomain forms; jsapi without the param → null.
  describe("trakstar", () => {
    it.each([
      ["https://jsapi.recruiterbox.com/v1/openings/?client_name=instacart", "instacart"],
      ["https://instacart.hire.trakstar.com/", "instacart"],
      ["https://instacart.recruiterbox.com/", "instacart"],
    ])("%s → %j", (url, slug) => {
      expect(matchUrl("trakstar", url)).toBe(slug);
    });

    it.each([
      ["https://jsapi.recruiterbox.com/v1/openings/", null], // no client_name → null, not "jsapi"
      ["https://jsapi.recruiterbox.com/v1/openings/?client_name=", null], // empty client_name → null
      ["https://cdn.recruiterbox.com/asset.js", null], // reserved infra subdomain
      ["https://example.com/", null],
    ])("%s → %j", (url, slug) => {
      expect(matchUrl("trakstar", url)).toBe(slug);
    });
  });
});

// The disjointness invariant from the old `only()` helper: a URL owned by one adapter must be
// claimed by EXACTLY that adapter and rejected (null) by all eight others.
describe("matchUrl ownership is disjoint across adapters", () => {
  const OWNED: ReadonlyArray<readonly [SourceName, string, string]> = [
    ["greenhouse", "https://boards.greenhouse.io/vercel", "vercel"],
    ["greenhouse", "https://job-boards.greenhouse.io/vercel", "vercel"],
    ["greenhouse", "https://boards.eu.greenhouse.io/acme", "acme"],
    ["greenhouse", "https://job-boards.eu.greenhouse.io/acme", "acme"],
    ["lever", "https://jobs.lever.co/leverdemo", "leverdemo"],
    ["ashby", "https://jobs.ashbyhq.com/Notion", "Notion"],
    ["workable", "https://apply.workable.com/fuku", "fuku"],
    ["smartrecruiters", "https://jobs.smartrecruiters.com/Visa", "Visa"],
    ["recruitee", "https://xite.recruitee.com/", "xite"],
    ["pinpoint", "https://workwithus.pinpointhq.com/postings.json", "workwithus"],
    ["gem", "https://jobs.gem.com/gem", "gem"],
    ["trakstar", "https://jsapi.recruiterbox.com/v1/openings/?client_name=instacart", "instacart"],
    ["trakstar", "https://instacart.hire.trakstar.com/", "instacart"],
    ["trakstar", "https://instacart.recruiterbox.com/", "instacart"],
  ] as const;

  it.each(OWNED)("%s exclusively owns %s", (owner, url, slug) => {
    expect(matchUrl(owner, url)).toBe(slug);
    for (const other of SOURCE_NAMES) {
      if (other === owner) continue;
      expect(matchUrl(other, url)).toBeNull();
    }
  });
});

// classifyProbe override map: only SmartRecruiters + Trakstar customize probe classification; the
// other seven inherit the default (status-only) outcome, so accidentally adding/removing an
// override would change which probes are treated as live/absent.
describe("classifyProbe override presence", () => {
  it.each(SOURCE_NAMES)("%s overrides only when it is SR or Trakstar", (source) => {
    const overrides = adapters[source].classifyProbe !== undefined;
    expect(overrides).toBe(source === "smartrecruiters" || source === "trakstar");
  });

  // SmartRecruiters: 200 + totalFound>0 = live; 200 + totalFound:0 / non-record = indeterminate.
  describe("smartrecruiters", () => {
    it.each<[number, unknown, ProbeOutcome]>([
      [200, { totalFound: 5, content: [] }, "live"],
      [200, { totalFound: 0 }, "indeterminate"],
      [404, undefined, "indeterminate"],
      [200, "not-json", "indeterminate"],
    ])("status %i, body %j → %s", (status, body, expected) => {
      expect(classify("smartrecruiters", status, body)).toBe(expected);
    });
  });

  // Trakstar: 400/404 = absent; 200 counts on meta.total; other status = indeterminate.
  describe("trakstar", () => {
    it.each<[number, unknown, ProbeOutcome]>([
      [400, undefined, "absent"],
      [200, { meta: { total: 3 }, objects: [] }, "live"],
      [200, { meta: { total: 0 }, objects: [] }, "live-empty"],
      [404, undefined, "absent"],
      [500, undefined, "indeterminate"],
    ])("status %i, body %j → %s", (status, body, expected) => {
      expect(classify("trakstar", status, body)).toBe(expected);
    });
  });
});
