/**
 * Unit suite for the per-digest liveness fan-out (src/probe.ts `probeDigestLiveness`). NO creds, NO network,
 * NO real DB — a stubbed probe seam + a chainable-thenable stub Db drive it. Locks the drop/close SPLIT and
 * the conservative classification: 2xx/3xx keep; 404 drops (no close); 410 drops AND closes (enforce) /
 * would-close (shadow); 5xx + timeout/error KEEP; an all-dead digest yields survivors 0 but STILL records.
 * The real fetch classifier `probeLiveness` is covered separately under MSW (probe.integration.test.ts).
 */
import { describe, expect, it } from "vitest";

import type { DigestApplyTarget } from "@opusfinder/db/repos";
import { recordingStep, stubDb } from "@test/inngest/stubs";

import { probeDigestLiveness, type LivenessOutcome, type LivenessProbe } from "./probe";

/** A probe seam that returns a canned verdict per URL (default: live). */
function probeBy(map: Record<string, LivenessOutcome>): LivenessProbe {
  return async (url) => map[url] ?? { verdict: "live", status: 200 };
}

function targets(...t: DigestApplyTarget[]): DigestApplyTarget[] {
  return t;
}

describe("probeDigestLiveness", () => {
  it("all live → every item kept, survivors = N, no close, one recount write", async () => {
    const { runs, tools } = recordingStep();
    const db = stubDb([
      targets({ jobId: 1, applyUrl: "u-live-1" }, { jobId: 2, applyUrl: "u-live-2" }),
      [], // dropDigestItemsAndRecount (zero drops, still records counts)
    ]);

    const r = await probeDigestLiveness(tools, db, probeBy({}), 7);

    expect(r.survivors).toBe(2);
    expect(r.counts.probedOk).toBe(2);
    expect(r.counts.probed404Dropped).toBe(0);
    expect(r.counts.probed410).toBe(0);
    expect(runs).toEqual(["liveness-probe"]); // runs as ONE memoized step
  });

  it("a single 404 → DROP, never close", async () => {
    const { tools } = recordingStep();
    const db = stubDb([
      targets(
        { jobId: 1, applyUrl: "u-live" },
        { jobId: 2, applyUrl: "u-404" },
        { jobId: 3, applyUrl: "u-live2" },
      ),
      [], // recount (job 2 dropped)
    ]);

    const r = await probeDigestLiveness(
      tools,
      db,
      probeBy({ "u-404": { verdict: "missing", status: 404 } }),
      7,
    );

    expect(r.counts.probed404Dropped).toBe(1);
    expect(r.counts.probed410).toBe(0);
    expect(r.counts.probed410Closed).toBe(0);
    expect(r.survivors).toBe(2);
  });

  it("a 410 in ENFORCE mode → DROP + close", async () => {
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

    expect(r.counts.probed410).toBe(1);
    expect(r.counts.probed410Closed).toBe(1);
    expect(r.counts.probed410WouldClose).toBe(0);
    expect(r.survivors).toBe(1);
  });

  it("a 410 in SHADOW (default) → DROP + would-close, writes no 'closed'", async () => {
    const { tools } = recordingStep();
    const db = stubDb([
      targets({ jobId: 1, applyUrl: "u-live" }, { jobId: 2, applyUrl: "u-410" }),
      [{ would_close: "1" }], // closeJobsByIds shadow: SELECT count(*)
      [], // recount
    ]);

    const r = await probeDigestLiveness(
      tools,
      db,
      probeBy({ "u-410": { verdict: "gone", status: 410 } }),
      7,
    );

    expect(r.counts.probed410WouldClose).toBe(1);
    expect(r.counts.probed410Closed).toBe(0);
    expect(r.survivors).toBe(1);
  });

  it("5xx + timeout/error → KEEP (ambiguous; never drop, never close)", async () => {
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

    expect(r.counts.probedErrorKept).toBe(2);
    expect(r.counts.probedOk).toBe(1);
    expect(r.counts.probed404Dropped).toBe(0);
    expect(r.survivors).toBe(3);
  });

  it("every item dead → survivors 0, the 410 still closes, recount still records", async () => {
    const { tools } = recordingStep();
    const db = stubDb([
      targets({ jobId: 1, applyUrl: "u-404" }, { jobId: 2, applyUrl: "u-410" }),
      [{ id: 2 }], // closeJobsByIds enforce for the 410
      [], // dropDigestItemsAndRecount (survivorCount 0 — empties the digest, still records the counts)
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

    expect(r.survivors).toBe(0);
    expect(r.counts.probed404Dropped).toBe(1);
    expect(r.counts.probed410).toBe(1);
    expect(r.counts.probed410Closed).toBe(1);
  });

  it("swallows a REJECTING probe seam to error/keep — never fails the memoized step", async () => {
    // The real probeLiveness catches internally; a misbehaving/stub seam that throws must be treated as
    // ambiguous 'error' (keep) via the per-target `.catch`, not propagate and block the send.
    const { runs, tools } = recordingStep();
    const db = stubDb([
      targets({ jobId: 1, applyUrl: "u-throws" }, { jobId: 2, applyUrl: "u-live" }),
      [], // recount (zero drops — the thrower is kept as error)
    ]);
    const throwingProbe: LivenessProbe = async (url) => {
      if (url === "u-throws") throw new Error("seam boom");
      return { verdict: "live", status: 200 };
    };

    const r = await probeDigestLiveness(tools, db, throwingProbe, 7);

    expect(r.counts.probedErrorKept).toBe(1);
    expect(r.counts.probedOk).toBe(1);
    expect(r.counts.probed404Dropped).toBe(0);
    expect(r.survivors).toBe(2);
    expect(runs).toEqual(["liveness-probe"]);
  });
});
