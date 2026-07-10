import { describe, expect, it } from "vitest";

import { fetchHnAlgoliaLane } from "./hn";

// The HN "Who is hiring?" live lane gate. Split out of hn.test.ts (whose offline `parseHnThread` suite
// stays there) so EVERY real-network egress is a `*.live.test.ts` in the no-MSW `live` project — the
// invariant `pnpm guard:tests` enforces. Two sequential Algolia fetches (each AbortSignal.timeout(10s))
// validate the search→items endpoints + title-filter + /items shape the offline fixture can't. NO creds
// (public API), but still gated on an EXPLICIT opt-in flag (repo idiom: HN_LIVE_TEST=1) so it SKIPS on
// every dev box and in the secret-free CI lane. Run with `HN_LIVE_TEST=1 pnpm test:live`. TOLERANT
// assertions only.
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
