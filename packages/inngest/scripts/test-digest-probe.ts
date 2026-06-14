/**
 * Stub-seam smoke for the F2 Arm C pre-send liveness probe (src/probe.ts) — NO creds, NO network, NO real
 * DB. Locks the drop/close SPLIT and the conservative classification: 2xx/3xx keep; 404 drops (no close);
 * 410 drops AND closes (enforce) / would-close (shadow); 5xx + timeout/error KEEP; an all-dead digest yields
 * survivors 0 but STILL records (empties items + folds the probe counts), while the caller keeps the 0-item
 * row and skips the send. The probe seam + a chainable-thenable Db stub drive it; the SQL round-trip itself is
 * the F2f live gate. The enforce-vs-shadow SQL shape is locked by `pnpm --filter @opusfinder/db test:lifecycle`.
 *
 *   pnpm --filter @opusfinder/inngest test:probe
 */
import type { DigestApplyTarget } from "@opusfinder/db/repos";
import { runScript } from "@opusfinder/shared/script";

import { recordingStep, stubDb } from "./_stub.ts";
import {
  probeDigestLiveness,
  type LivenessOutcome,
  type LivenessProbe,
} from "../src/probe.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** A probe seam that returns a canned verdict per URL (default: live). */
function probeBy(map: Record<string, LivenessOutcome>): LivenessProbe {
  return async (url) => map[url] ?? { verdict: "live", status: 200 };
}

function targets(...t: DigestApplyTarget[]): DigestApplyTarget[] {
  return t;
}

await runScript("test-digest-probe", async () => {
  // A) All live → every item kept, survivors = N, no close, one recount write.
  {
    const { runs, tools } = recordingStep();
    const db = stubDb([
      targets({ jobId: 1, applyUrl: "u-live-1" }, { jobId: 2, applyUrl: "u-live-2" }),
      [], // dropDigestItemsAndRecount (zero drops, still records counts)
    ]);
    const r = await probeDigestLiveness(tools, db, probeBy({}), 7);
    assert(r.survivors === 2, `all-live survivors: ${r.survivors}`);
    assert(r.counts.probedOk === 2, "all-live must keep both");
    assert(r.counts.probed404Dropped === 0 && r.counts.probed410 === 0, "all-live drops nothing");
    assert(runs.includes("liveness-probe"), "the probe must run as a memoized step");
  }

  // B) A single 404 → DROP, never close.
  {
    const { tools } = recordingStep();
    const db = stubDb([
      targets(
        { jobId: 1, applyUrl: "u-live" },
        { jobId: 2, applyUrl: "u-404" },
        { jobId: 3, applyUrl: "u-live2" },
      ),
      [], // recount (job 2 dropped)
    ]);
    const r = await probeDigestLiveness(tools, db, probeBy({ "u-404": { verdict: "missing", status: 404 } }), 7);
    assert(r.counts.probed404Dropped === 1, "404 must drop one");
    assert(r.counts.probed410 === 0 && r.counts.probed410Closed === 0, "a 404 must NEVER close");
    assert(r.survivors === 2, `404 survivors: ${r.survivors}`);
  }

  // C) A 410 in ENFORCE mode → DROP + close.
  {
    const { tools } = recordingStep();
    const db = stubDb([
      targets({ jobId: 1, applyUrl: "u-live" }, { jobId: 2, applyUrl: "u-410" }),
      [{ id: 2 }], // closeJobsByIds enforce: UPDATE ... RETURNING id → 1 closed
      [], // recount
    ]);
    const r = await probeDigestLiveness(
      tools,
      db,
      probeBy({ "u-410": { verdict: "gone", status: 410 } }),
      7,
      { enforce: true },
    );
    assert(r.counts.probed410 === 1, "410 must be tallied");
    assert(r.counts.probed410Closed === 1, "enforce must close the 410 job");
    assert(r.counts.probed410WouldClose === 0, "enforce must not would-close");
    assert(r.survivors === 1, `410-enforce survivors: ${r.survivors}`);
  }

  // D) A 410 in SHADOW (default) → DROP + count would-close, write no 'closed'.
  {
    const { tools } = recordingStep();
    const db = stubDb([
      targets({ jobId: 1, applyUrl: "u-live" }, { jobId: 2, applyUrl: "u-410" }),
      [{ would_close: "1" }], // closeJobsByIds shadow: SELECT count(*)
      [], // recount
    ]);
    const r = await probeDigestLiveness(tools, db, probeBy({ "u-410": { verdict: "gone", status: 410 } }), 7);
    assert(r.counts.probed410WouldClose === 1, "shadow must would-close the 410 job");
    assert(r.counts.probed410Closed === 0, "shadow must NOT write closed");
    assert(r.survivors === 1, `410-shadow survivors: ${r.survivors}`);
  }

  // E) 5xx + timeout/error → KEEP (ambiguous; never drop, never close).
  {
    const { tools } = recordingStep();
    const db = stubDb([
      targets(
        { jobId: 1, applyUrl: "u-503" },
        { jobId: 2, applyUrl: "u-timeout" },
        { jobId: 3, applyUrl: "u-live" },
      ),
      [], // recount (zero drops)
    ]);
    const r = await probeDigestLiveness(
      tools,
      db,
      probeBy({ "u-503": { verdict: "error", status: 503 }, "u-timeout": { verdict: "error" } }),
      7,
    );
    assert(r.counts.probedErrorKept === 2, "5xx + timeout must be kept");
    assert(r.counts.probedOk === 1, "the live one is kept too");
    assert(r.counts.probed404Dropped === 0, "ambiguous must not drop");
    assert(r.survivors === 3, `error-keep survivors: ${r.survivors}`);
  }

  // F) Every item dead → survivors 0, the 410 still closes, AND the recount still records (review fix: the
  //    all-dead case stays visible to the shadow analysis; the caller keeps the 0-item row and skips the send).
  {
    const { tools } = recordingStep();
    const db = stubDb([
      targets({ jobId: 1, applyUrl: "u-404" }, { jobId: 2, applyUrl: "u-410" }),
      [{ id: 2 }], // closeJobsByIds enforce for the 410
      [], // dropDigestItemsAndRecount (survivorCount 0 — empties the digest, still records the probe counts)
    ]);
    const r = await probeDigestLiveness(
      tools,
      db,
      probeBy({
        "u-404": { verdict: "missing", status: 404 },
        "u-410": { verdict: "gone", status: 410 },
      }),
      7,
      { enforce: true },
    );
    assert(r.survivors === 0, `all-dead survivors: ${r.survivors}`);
    assert(r.counts.probed404Dropped === 1 && r.counts.probed410 === 1, "both dead links counted");
    assert(r.counts.probed410Closed === 1, "the 410 still closes on the all-dead path");
  }

  console.log(
    "test-digest-probe OK — live keeps; 404 drops (no close); 410 drops+closes (enforce) / would-closes " +
      "(shadow); 5xx+timeout keep; all-dead → survivors 0, recount still records.",
  );
});
