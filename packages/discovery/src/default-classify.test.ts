import { describe, expect, it, vi } from "vitest";

import { companySlug } from "@opusfinder/shared";
import type { SourceAdapter, SourceContext } from "@opusfinder/sources";

import { defaultClassify } from "./probe";

// Leaf pure-unit for the status-first default probe classifier (used by 7 of 9 adapters). The
// load-bearing truth table: a 404 is `absent` WITHOUT ever calling `locate` (so a definitive
// not-found short-circuits the body read); a 2xx runs `locate` (non-empty ⇒ live, empty ⇒
// live-empty, a throw on a malformed envelope ⇒ indeterminate); a body-less 2xx and every other
// status (0 / 3xx / non-404 4xx) are `indeterminate`, so the default classifier can NEVER drive a
// deactivation. Uses a HAND-ROLLED stub SourceAdapter whose `locate` is a spy — no real adapter.

const ctx: SourceContext = { slug: companySlug("acme"), rawSlug: "acme" };

// A minimal, fully-typed SourceAdapter — only `locate` is exercised; the rest satisfy the contract.
function makeAdapter(locate: SourceAdapter["locate"]): SourceAdapter {
  return {
    source: "greenhouse",
    normalizeSlug: (rawSlug) => companySlug(rawSlug),
    matchUrl: () => null,
    jobsRequest: () => ({ url: "https://example.invalid/probe" }),
    locate,
    mapItem: () => null,
  };
}

describe("defaultClassify", () => {
  it("404 → absent WITHOUT calling locate", () => {
    const locate = vi.fn<SourceAdapter["locate"]>(() => []);

    expect(defaultClassify(makeAdapter(locate), 404, undefined, ctx)).toBe("absent");
    expect(locate).not.toHaveBeenCalled();
  });

  it("2xx + locate returns a non-empty array → live", () => {
    const locate = vi.fn<SourceAdapter["locate"]>(() => [{ id: 1 }]);

    expect(defaultClassify(makeAdapter(locate), 200, { jobs: [{ id: 1 }] }, ctx)).toBe("live");
    expect(locate).toHaveBeenCalledTimes(1);
  });

  it("2xx + locate returns an empty array → live-empty", () => {
    const locate = vi.fn<SourceAdapter["locate"]>(() => []);

    expect(defaultClassify(makeAdapter(locate), 200, { jobs: [] }, ctx)).toBe("live-empty");
    expect(locate).toHaveBeenCalledTimes(1); // the empty-array branch actually ran locate
  });

  it("2xx + undefined body → indeterminate WITHOUT calling locate", () => {
    const locate = vi.fn<SourceAdapter["locate"]>(() => [{ id: 1 }]);

    expect(defaultClassify(makeAdapter(locate), 200, undefined, ctx)).toBe("indeterminate");
    expect(locate).not.toHaveBeenCalled();
  });

  it("2xx + locate throws on a bad envelope → indeterminate", () => {
    const locate = vi.fn<SourceAdapter["locate"]>(() => {
      throw new Error("unexpected response shape");
    });

    expect(defaultClassify(makeAdapter(locate), 200, {}, ctx)).toBe("indeterminate");
  });

  // status 0 (network-exhausted), a 3xx, and a non-404 4xx are all indeterminate and never call locate.
  // A DEFINED body is passed on purpose: if a status-boundary bug routed one of these into the 2xx
  // branch, locate would run and yield "live" — so this isolates the final indeterminate fallthrough
  // from the body===undefined short-circuit (which would otherwise mask such a bug).
  it.each([0, 302, 403])("status %i → indeterminate WITHOUT calling locate", (status) => {
    const locate = vi.fn<SourceAdapter["locate"]>(() => [{ id: 1 }]);

    expect(defaultClassify(makeAdapter(locate), status, { jobs: [{ id: 1 }] }, ctx)).toBe(
      "indeterminate",
    );
    expect(locate).not.toHaveBeenCalled();
  });
});
