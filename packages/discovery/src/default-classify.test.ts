import { describe, expect, it } from "vitest";

import { defaultClassify } from "./probe";

// Leaf pure-unit for the status-first default probe classifier (used by 7 of 9 adapters). The
// load-bearing truth table: a 404 is `absent` whatever the page; a 2xx listing page is `live` when it
// lists a posting and `live-empty` when it lists none; a 2xx that isn't a listing page (no page) and every
// other status (0 / 3xx / non-404 4xx) are `indeterminate`, so the default classifier can NEVER drive a
// deactivation.

const listing = { listsPosting: true, envelope: undefined };
const emptyListing = { listsPosting: false, envelope: { jobs: [] } };

describe("defaultClassify", () => {
  it("404 → absent, whatever the page", () => {
    expect(defaultClassify(404, undefined)).toBe("absent");
    expect(defaultClassify(404, listing)).toBe("absent");
  });

  it("2xx + a page listing a posting → live", () => {
    expect(defaultClassify(200, listing)).toBe("live");
  });

  it("2xx + a page listing none → live-empty", () => {
    expect(defaultClassify(200, emptyListing)).toBe("live-empty");
  });

  it("2xx + no page (not JSON, or no postings array) → indeterminate", () => {
    expect(defaultClassify(200, undefined)).toBe("indeterminate");
  });

  // A page listing a posting is passed on purpose: if a status-boundary bug routed one of these into the
  // 2xx branch, it would read "live" — so this isolates the final indeterminate fallthrough.
  it.each([0, 302, 403])("status %i → indeterminate", (status) => {
    expect(defaultClassify(status, listing)).toBe("indeterminate");
  });
});
