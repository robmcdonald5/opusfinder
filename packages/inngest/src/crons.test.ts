import { describe, expect, it } from "vitest";

import { createDigestFunctions, DIGEST_CADENCE_CRON, type DigestDeps } from "./digest";
import { createHealthFunctions, HEALTH_CHECK_CRON, type HealthCheckDeps } from "./health-check";

// Leaf pure-unit: the Inngest crons are timed to ride the scrapers Worker's ingestion ticks (`0 */2 * * *`,
// apps/scrapers/wrangler.toml), so their Neon reads land while a tick already has Neon awake instead of each
// paying its own 5-min autosuspend tail. This pins the strings ACTUALLY registered on the functions (not
// just the constants), so a function quietly keeping an old literal fails here. Deps are never touched:
// building a function only records its config.
function cronOf(fns: Array<{ opts: unknown }>, id: string): unknown {
  const fn = fns.find((f) => (f.opts as { id?: string }).id === id);
  expect(fn, `no function "${id}"`).toBeDefined();
  return (fn!.opts as { triggers?: unknown }).triggers;
}

describe("Inngest crons ride the 2-hourly ingestion ticks", () => {
  it("health-check-alert fires every 2 h at :10 — 10 min after each ingest tick starts", () => {
    expect(HEALTH_CHECK_CRON).toBe("10 */2 * * *");
    const fns = createHealthFunctions({} as HealthCheckDeps) as unknown as Array<{ opts: unknown }>;
    expect(cronOf(fns, "health-check-alert")).toEqual([{ cron: HEALTH_CHECK_CRON }]);
  });

  it("digest-cadence fires daily at 12:10 UTC — 10 min after the 12:00 ingest tick (8:10am EDT)", () => {
    expect(DIGEST_CADENCE_CRON).toBe("10 12 * * *");
    const fns = createDigestFunctions({} as DigestDeps) as unknown as Array<{ opts: unknown }>;
    expect(cronOf(fns, "digest-cadence")).toEqual([{ cron: DIGEST_CADENCE_CRON }]);
  });
});
