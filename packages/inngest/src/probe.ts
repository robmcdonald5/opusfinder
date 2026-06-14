import type { Db } from "@opusfinder/db";
import {
  closeJobsByIds,
  dropDigestItemsAndRecount,
  getDigestApplyTargets,
} from "@opusfinder/db/repos";

/**
 * Phase F2 Arm C — the pre-send liveness probe of `digest-user`. Before the email goes out, HEAD/GET the
 * ≤TOP_K persisted items' apply URLs and DROP the dead links so the user never clicks Apply into a 404 (the
 * phase's worst case). Conservative scope (ratified F2-ARM-C-SCOPE):
 *   - 2xx/3xx → KEEP (live).
 *   - 404      → DROP from this digest, do NOT close (a bare 404 can be a CDN/geo blip).
 *   - 410 Gone → DROP and soft-close the job (definitive, intended-permanent). Count-only first
 *                (F2-SHADOW: tally `probed410WouldClose`); F2-enforce flips the close write on.
 *   - 5xx / timeout / network / other 4xx → KEEP (ambiguous — never lose a possibly-live match over a blip,
 *                and never close).
 * Runs in the Node Inngest runtime (Worker-isolation-free — `@opusfinder/inngest` is barred from the scraper
 * bundle), so the outbound fetch has no subrequest budget. The fetch is an INJECTED seam (`LivenessProbe`,
 * like delivery.ts's `EmailSeam`) so the stub smoke drives it with a fake. The whole pass is ONE memoized
 * step, so it runs exactly once, not on a synthesis-poll replay.
 */

/** Per-URL probe verdict. `live`/`error` → keep; `missing` (404) → drop only; `gone` (410) → drop + close. */
export interface LivenessOutcome {
  verdict: "live" | "missing" | "gone" | "error";
  status?: number;
}

/** The `DigestDeps.probe` seam — wired to the real `probeLiveness` by buildDigestDeps (./deps), stubbed by
 *  the smoke. One URL in, one verdict out; the per-digest fan-out + DB writes live in `probeDigestLiveness`. */
export type LivenessProbe = (url: string) => Promise<LivenessOutcome>;

/** The one step primitive this module uses — structural, so the stub smoke drives it with a fake step that
 *  records ids and runs `fn` inline, while Inngest's real `step.run` passes straight through. */
export interface ProbeStepTools {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

/** Per-digest probe tallies, folded into `digests.counts` (the index signature keeps it assignable to the
 *  db `RunCounts` = Record<string, number>). */
export interface ProbeCounts {
  [key: string]: number;
  probedChecked: number; // items probed
  probedOk: number; // 2xx/3xx — kept
  probed404Dropped: number; // 404 — dropped, not closed
  probed410: number; // 410 — dropped (and closed/would-close)
  probed410Closed: number; // 410 jobs flipped to 'closed' (enforce only; 0 in shadow)
  probed410WouldClose: number; // 410 jobs that WOULD close (shadow; 0 in enforce)
  probedErrorKept: number; // 5xx/timeout/network/other-4xx — kept (ambiguous)
}

function emptyProbeCounts(): ProbeCounts {
  return {
    probedChecked: 0,
    probedOk: 0,
    probed404Dropped: 0,
    probed410: 0,
    probed410Closed: 0,
    probed410WouldClose: 0,
    probedErrorKept: 0,
  };
}

const PROBE_TIMEOUT_MS = 5000;

/** The real probe: HEAD (falling back to GET when an ATS rejects HEAD with 405/501), a short per-request
 *  timeout, classify the status. A network error / timeout is `error` (keep) — only an explicit 404/410 is
 *  actionable. Best-effort: any throw becomes `error`, so a flaky URL never fails the digest. */
export const probeLiveness: LivenessProbe = async (url) => {
  let status = await fetchStatus(url, "HEAD");
  if (status === 405 || status === 501) status = await fetchStatus(url, "GET");
  if (status === "error") return { verdict: "error" };
  if (status === 410) return { verdict: "gone", status };
  if (status === 404) return { verdict: "missing", status };
  if (status >= 200 && status < 400) return { verdict: "live", status };
  return { verdict: "error", status }; // other 4xx / 5xx → ambiguous → keep, never close
};

async function fetchStatus(url: string, method: "HEAD" | "GET"): Promise<number | "error"> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, redirect: "follow", signal: ctrl.signal });
    return res.status;
  } catch {
    return "error"; // DNS / connection / timeout-abort — ambiguous, kept upstream
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe one digest's items and apply the drop/close split, in ONE memoized step. Re-reads the items' apply
 * URLs by digest id (not threaded through step state — the embedding-re-read discipline), probes them in
 * parallel (≤TOP_K, each with its own timeout, so a slow ATS can't stall the send), closes the explicit-410
 * jobs (enforce-gated), and drops the dead links from `digest_items` (keeping the persisted items equal to
 * what is sent). Returns the survivor count — when it is 0 the caller drops the whole digest and sends no
 * email. `opts.enforce` is false by default (F2-SHADOW count-only first); F2-enforce flips it on.
 */
export async function probeDigestLiveness(
  step: ProbeStepTools,
  db: Db,
  probe: LivenessProbe,
  digestId: number,
  opts: { enforce?: boolean } = {},
): Promise<{ survivors: number; counts: ProbeCounts }> {
  return step.run("liveness-probe", async () => {
    const counts = emptyProbeCounts();
    const targets = await getDigestApplyTargets(db, digestId);
    counts.probedChecked = targets.length;
    if (targets.length === 0) return { survivors: 0, counts };

    const results = await Promise.all(
      targets.map(async (t) => ({
        jobId: t.jobId,
        // A misbehaving/stub seam that REJECTS (the real probeLiveness never does — it catches internally)
        // must not fail the whole memoized step and block the send; treat a throw as ambiguous 'error' (keep).
        outcome: await probe(t.applyUrl).catch((): LivenessOutcome => ({ verdict: "error" })),
      })),
    );

    const droppedJobIds: number[] = [];
    const goneJobIds: number[] = [];
    for (const { jobId, outcome } of results) {
      switch (outcome.verdict) {
        case "live":
          counts.probedOk++;
          break;
        case "missing":
          // 404 → drop from THIS digest but never close (may be a transient blip). NB this also removes the
          // job from shown-history (digest_items), so a persistently-404-but-active job can re-surface on a
          // later digest until Arm A / recency clears it — see dropDigestItemsAndRecount's coupling caveat.
          counts.probed404Dropped++;
          droppedJobIds.push(jobId);
          break;
        case "gone":
          counts.probed410++;
          droppedJobIds.push(jobId);
          goneJobIds.push(jobId);
          break;
        case "error":
          counts.probedErrorKept++;
          break;
      }
    }

    if (goneJobIds.length > 0) {
      const close = await closeJobsByIds(db, goneJobIds, { enforce: opts.enforce ?? false });
      counts.probed410Closed = close.closed;
      counts.probed410WouldClose = close.wouldClose;
    }

    const survivors = targets.length - droppedJobIds.length;
    // Always record — even when every item is dead: drop the dead digest_items, set item_count (= survivors),
    // and fold the probe counts into digests.counts. This keeps the F2-SHADOW analysis visible on the all-dead
    // digests too (the worst case the enforce decision most needs to see). On all-dead the caller keeps the
    // 0-item row (audit) and simply skips the send.
    await dropDigestItemsAndRecount(db, digestId, droppedJobIds, survivors, counts);

    // Shape-only (counts, never titles/URLs) — the item-6 health signal.
    console.log(
      `digest ${digestId} liveness: checked ${counts.probedChecked}, ok ${counts.probedOk}, ` +
        `404-drop ${counts.probed404Dropped}, 410 ${counts.probed410} ` +
        `(closed ${counts.probed410Closed}, would-close ${counts.probed410WouldClose}), ` +
        `error-keep ${counts.probedErrorKept}, survivors ${survivors}.`,
    );
    return { survivors, counts };
  });
}
