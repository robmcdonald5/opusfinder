import { describe, expect, it } from "vitest";

import { resolveSeed } from "./resolve";
import { loadSeed } from "./seed";

// The outscal seed live gate. Split out of resolve.test.ts (whose offline resolveUrl/resolveSeed suite
// stays there) so EVERY real-network egress is a `*.live.test.ts` in the no-MSW `live` project — the
// invariant `pnpm guard:tests` enforces. Fetches the pinned public seed (raw.githubusercontent, NO creds)
// and folds it through the real resolver. Gated on an EXPLICIT opt-in flag (repo idiom: OUTSCAL_SEED_LIVE=1)
// so it SKIPS on every dev box and in the secret-free CI lane. Run with `OUTSCAL_SEED_LIVE=1 pnpm test:live`.
// Loose assertions only.
const LIVE = process.env.OUTSCAL_SEED_LIVE === "1";

describe.skipIf(!LIVE)("resolveSeed — live outscal seed", () => {
  it(
    "the pinned seed yields > 0 candidates across multiple distinct sources",
    async () => {
      const live = await loadSeed();
      const { candidates, counts } = resolveSeed(live);

      expect(counts.seedRecords).toBeGreaterThan(1000);
      expect(counts.candidates).toBeGreaterThan(0);
      const distinctSources = new Set(candidates.map((c) => c.source));
      expect(distinctSources.size).toBeGreaterThan(1);
    },
    60_000,
  );
});
