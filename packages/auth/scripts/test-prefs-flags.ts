import { runScript } from "@opusfinder/shared/script";

import { parseLocationMode, prefsFromFlags } from "./cli-utils";

/**
 * Stub smoke for the F3 CLI flag parsing — NO creds, NO DB. prefsFromFlags is a pure
 * Record<string,string> → Partial<UserPreferences> mapper; this locks the F3 additions without a live
 * user: the new union validators, the `clear` sentinel for nullable bounds, the partial min≤max guard,
 * array clearing, falsy-zero survival, and the removal of the old `--remote` flag.
 *
 *   pnpm --filter @opusfinder/auth test:prefs-flags
 */
await runScript("test-prefs-flags", async () => {
  // 1) location-mode: valid parses; invalid throws an actionable (secret-free) error.
  assert(prefsFromFlags({ "location-mode": "remote_only" }).locationMode === "remote_only", "location-mode parses");
  throws(() => parseLocationMode("hybrid"), "an unknown location-mode must throw");
  throws(() => prefsFromFlags({ "location-mode": "bogus" }), "prefsFromFlags rejects a bad location-mode");

  // 2) nullable-int `clear` sentinel: "clear" and "" → null; a number parses; 0 SURVIVES (not unset).
  assert(prefsFromFlags({ "max-salary": "clear" }).maxSalary === null, "max-salary 'clear' → null");
  assert(prefsFromFlags({ "max-salary": "" }).maxSalary === null, "max-salary '' → null (empty clears)");
  assert(prefsFromFlags({ "max-salary": "180000" }).maxSalary === 180000, "max-salary number parses");
  assert(prefsFromFlags({ "min-yoe": "0" }).yoeMin === 0, "min-yoe 0 must survive (falsy-zero is a real value)");

  // 3) Partial min≤max guard (same-invocation only): reversed bounds throw; ordered/one-sided/cleared pass.
  throws(() => prefsFromFlags({ "min-salary": "200000", "max-salary": "100000" }), "min-salary > max-salary must throw");
  throws(() => prefsFromFlags({ "min-yoe": "8", "max-yoe": "2" }), "min-yoe > max-yoe must throw");
  assert(
    prefsFromFlags({ "min-salary": "100000", "max-salary": "200000" }).minSalary === 100000,
    "ordered salary bounds pass",
  );
  assert(prefsFromFlags({ "min-salary": "200000" }).minSalary === 200000, "a lone floor passes (no max to compare)");
  assert(
    prefsFromFlags({ "min-salary": "clear", "max-salary": "100000" }).maxSalary === 100000,
    "a cleared floor (null) does not trip the guard",
  );

  // 4) Free-text arrays: comma-split + trim; "" empties the array (a clear); omit leaves it unset.
  assert(
    JSON.stringify(prefsFromFlags({ dealbreakers: "crypto, on-site" }).dealbreakers) === '["crypto","on-site"]',
    "dealbreakers comma-split + trim",
  );
  assert(
    JSON.stringify(prefsFromFlags({ dealbreakers: "" }).dealbreakers) === "[]",
    "dealbreakers '' → [] (clears)",
  );
  assert(
    JSON.stringify(prefsFromFlags({ exclusions: "a,b" }).exclusions) === '["a","b"]',
    "exclusions wired (closes the pre-F3 CLI gap)",
  );

  // 5) Omitted flags → absent keys (the toRow undefined-drop contract); empty input → empty patch.
  assert(Object.keys(prefsFromFlags({})).length === 0, "no flags → empty patch");
  {
    const p = prefsFromFlags({ "min-salary": "5" });
    assert("minSalary" in p && !("maxSalary" in p) && !("yoeMin" in p), "only the passed flag appears");
  }

  // 6) The removed `--remote` flag is ignored — it no longer maps to anything (subsumed by location-mode).
  assert(!("remoteOk" in prefsFromFlags({ remote: "true" })), "the retired --remote flag must not map");

  console.log(
    "test-prefs-flags OK — location-mode validator, nullable clear sentinel, falsy-zero survives, " +
      "partial min≤max guard, array clear, exclusions gap closed, retired --remote ignored.",
  );
});

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function throws(fn: () => unknown, msg: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`expected throw: ${msg}`);
}
