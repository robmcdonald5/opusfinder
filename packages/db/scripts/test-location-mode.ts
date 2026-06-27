import { runScript } from "@opusfinder/shared/script";

import { geoMatches } from "../src/repos/retrieval";

/**
 * Stub smoke for the location filter — the pure geoMatches truth table, NO creds, NO Postgres.
 * geoMatches is the ONE deterministic filter shipped now (salary/YoE are stored + soft-prompt only), so
 * a wrong branch silently drops or keeps the wrong jobs. Two non-obvious rules:
 *   - the unknown-location-passes rule (job has no location data → keep) holds under any/onsite_only;
 *   - the legacy boolean mapping is preserved: remote_ok=true ≡ 'any', remote_ok=false ≡ 'onsite_only'.
 *
 *   pnpm --filter @opusfinder/db test:location
 */
const REMOTE = { remote: true, locations: [] as string[] };
const ONSITE_SF = { remote: false, locations: ["San Francisco, CA"] };
const ONSITE_UNKNOWN = { remote: false, locations: [] as string[] }; // ATS left location empty
const SF = ["San Francisco"];

await runScript("test-location-mode", async () => {
  // 1) A REMOTE job: kept under 'any' and 'remote_only', DROPPED under 'onsite_only'. The locations list
  //    is irrelevant for a remote job.
  assert(geoMatches(REMOTE, "any", SF) === true, "remote job must pass under 'any'");
  assert(geoMatches(REMOTE, "remote_only", SF) === true, "remote job must pass under 'remote_only'");
  assert(geoMatches(REMOTE, "onsite_only", SF) === false, "remote job must be DROPPED under 'onsite_only'");
  assert(geoMatches(REMOTE, "remote_only", []) === true, "remote job passes remote_only with no locations");

  // 2) An ON-SITE job: DROPPED under 'remote_only'; under 'any'/'onsite_only' it honors the locations
  //    allowlist (overlap → keep; no overlap → drop).
  assert(geoMatches(ONSITE_SF, "remote_only", SF) === false, "on-site job must be DROPPED under 'remote_only'");
  assert(geoMatches(ONSITE_SF, "any", SF) === true, "on-site job in SF must pass under 'any' with matching location");
  assert(geoMatches(ONSITE_SF, "onsite_only", SF) === true, "on-site job in SF must pass under 'onsite_only' with match");
  assert(
    geoMatches(ONSITE_SF, "onsite_only", ["New York"]) === false,
    "on-site SF job must be dropped under 'onsite_only' when locations don't overlap",
  );

  // 3) No location CONSTRAINT (empty user locations): an on-site job passes under any/onsite_only.
  assert(geoMatches(ONSITE_SF, "any", []) === true, "on-site job passes 'any' with no location constraint");
  assert(geoMatches(ONSITE_SF, "onsite_only", []) === true, "on-site job passes 'onsite_only' with no constraint");

  // 4) Unknown-location-passes (recall guard): a job with NO location data is kept under any/onsite_only
  //    even with a location constraint set — unknown ≠ mismatch (retrieval.ts header / geoMatches doc).
  assert(
    geoMatches(ONSITE_UNKNOWN, "onsite_only", SF) === true,
    "unknown-location on-site job must pass (unknown ≠ mismatch)",
  );
  assert(geoMatches(ONSITE_UNKNOWN, "any", SF) === true, "unknown-location on-site job must pass under 'any'");

  // 5) Legacy boolean mapping preserved: remote_ok=true ≡ 'any', remote_ok=false ≡ 'onsite_only'. The old
  //    behavior was "remote job passes iff remote_ok; on-site passes by the locations rule". Verify both.
  //    'any' reproduces remote_ok=true (remote kept); 'onsite_only' reproduces remote_ok=false (remote dropped).
  assert(geoMatches(REMOTE, "any", SF) === true, "any ≡ remote_ok=true: remote kept");
  assert(geoMatches(REMOTE, "onsite_only", SF) === false, "onsite_only ≡ remote_ok=false: remote dropped");
  assert(geoMatches(ONSITE_SF, "any", SF) === geoMatches(ONSITE_SF, "onsite_only", SF), "on-site path identical for any/onsite_only");

  console.log(
    "test-location-mode OK — remote kept under any/remote_only & dropped under onsite_only; on-site dropped " +
      "under remote_only & allowlisted otherwise; unknown-location passes; legacy remote_ok mapping preserved.",
  );
});

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
