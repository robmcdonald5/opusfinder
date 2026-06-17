import type { Db } from "@opusfinder/db";
import {
  alreadyShownJobIds,
  alreadyShownSignatures,
  deleteUserDigestForRun,
  finishDigestRun,
  getPreferences,
  getProfileForDigest,
  insertDigest,
  insertDigestItems,
  listDigestRecipients,
  markDigestConsidered,
  retrieveCandidatesForProfile,
  startDigestRun,
  type UserPreferencesRow,
} from "@opusfinder/db/repos";
import { buildDigestSystem, renderDigestJob } from "@opusfinder/llm";
import type { BatchPoll, BatchRequest, BatchResult } from "@opusfinder/llm";
import type { RerankCandidate } from "@opusfinder/rerank";
import type { LocationMode, PromptPreferences, StructuredProfile, UserId } from "@opusfinder/shared";
import { NonRetriableError } from "inngest";

import { deliverDigestEmail, type EmailSeam } from "./delivery";
import { inngest } from "./inngest";
import { probeDigestLiveness, type LivenessProbe } from "./probe";

// --- Tunables (per-digest knobs) ---------------------------------------------------------------
const RETRIEVE_LIMIT = 50; // vector candidates pulled per user
const TOP_K = 12; // items reranked into the digest
/** Quality floor (Phase F3 follow-up): drop reranked items scored below this BEFORE taking the top-K, so a
 *  thin/weak match set yields a SHORTER (or empty) digest instead of padding to TOP_K with roles the
 *  synthesis note only flags as bad fits (the trust problem). 0.5 = the rerank rubric's "moderate fit" band
 *  floor — below it is "weak/poor". A SILENT-DROP tunable (too high quietly empties digests), so it ships
 *  ENFORCE at a conservative 0.5 but should be tuned against real digests; a shadow `would-drop` tally is
 *  the proper follow-up (see FEATURE_TODO — "digest quality floor"). */
const MIN_SCORE = 0.5;
const RECIPIENT_CHUNK = 200; // keyset page for the --all recipient sweep
/** Step-state cap on a candidate's description. Keep ≥ the synthesis renderer's `descriptionChars`
 *  default (2000; rerank's 1500 cut is below both) so this pre-trim is the only lossy one. */
const DESCRIPTION_STATE_CHARS = 2000;
const SYNTH_INITIAL_WAIT = "30s"; // first sleep before polling the synthesis batch
// Poll schedule spanning the API's 24h batch SLA in ONE attempt: 2m apart for the first hour (most
// batches end there), then 10m for the long tail — ~340 steps worst-case, well under Inngest's
// per-run step budget, and every sleep suspends at zero compute. Step ids depend ONLY on the loop
// index, never on ctx.attempt: `attempt` also increments on STEP retries (and resets when a step
// completes), so an attempt-scoped id would re-derive mid-request and orphan a retried step's target.
// Past 24h the batch is expired server-side — retries can't recover it — so exhaustion fails the run.
const SYNTH_FAST_POLLS = 30; // 2m apart — the first hour
const SYNTH_FAST_INTERVAL = "2m";
const SYNTH_SLOW_POLLS = 138; // 10m apart — the tail out to the 24h batch expiry
const SYNTH_SLOW_INTERVAL = "10m";
const SYNTH_MAX_POLLS = SYNTH_FAST_POLLS + SYNTH_SLOW_POLLS;

/** Matches the CLI's gate — the event schema is compile-time only, so the orchestrator re-checks at
 *  runtime (an empty string is falsy-shaped junk that must not widen into an all-recipients run). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The rerank result the per-user function consumes: a global ordering, the score map, and the
 *  aggregated prompt-cache counters across the rerank's chunk calls (the "cache hit rate >0" gate). */
export interface RerankOutcome {
  orderedIds: number[];
  scores: Map<number, number>;
  cache: { creationInputTokens: number; readInputTokens: number };
}

/**
 * Injected seams for the digest functions — so the pipeline is testable with stubs and the heavy
 * `@opusfinder/llm` wiring stays out of this module. `buildDigestDeps()` (./deps) wires the real ones.
 * `rerank` runs the shared `@opusfinder/rerank` core (sync Haiku, prompt-cached); `batch` is the
 * Anthropic Message Batches lifecycle for synthesis; `email` is the Phase-11 Resend send +
 * delivery-state read (./delivery).
 */
export interface DigestDeps {
  db: Db;
  rerank: (
    profile: StructuredProfile,
    candidates: RerankCandidate[],
    prefs?: PromptPreferences,
  ) => Promise<RerankOutcome>;
  batch: {
    submit: (requests: BatchRequest[]) => Promise<string>;
    poll: (batchId: string) => Promise<BatchPoll>;
    collect: (batchId: string) => Promise<Map<string, BatchResult>>;
  };
  email: EmailSeam;
  /** F2 Arm C — the pre-send apply-URL liveness probe (one URL → verdict); the per-digest fan-out lives
   *  in `probeDigestLiveness`. Injected so the stub smoke drives it with a fake. */
  probe: LivenessProbe;
}

interface FilterPrefs {
  locationMode: LocationMode;
  locations: string[];
  recencyDays: number;
  exclusions: string[];
}

/** The digest's filter inputs off a preferences row (the filter columns are NOT NULL with schema
 *  defaults — the defaults live in ONE place, the schema). `dealbreakers` (Phase F3) are MERGED into the
 *  `exclusions` list here — they ride the same whole-word compileExclusions matcher in retrieval, so this
 *  is the single row→filter mapper and retrieval.ts needs no new predicate. minSalary/maxSalary are
 *  intentionally omitted: there is no job-side salary column (Phase F4 enrichment was built then removed,
 *  PR #31), so salary lives only in user_preferences and rides the soft prompt signal (toPromptPrefs) —
 *  it is never a hard retrieval filter. */
function toFilterPrefs(prefs: UserPreferencesRow): FilterPrefs {
  return {
    locationMode: prefs.locationMode,
    locations: prefs.locations,
    recencyDays: prefs.recencyDays,
    exclusions: [...prefs.exclusions, ...prefs.dealbreakers],
  };
}

/** The judgment-context subset (Phase F3) injected into the rerank + synthesis PROMPT — the YoE band /
 *  salary range / dealbreakers. Slim strings + numbers, so it is safe to carry in the memoized `load` step
 *  state (unlike the 1024-dim embedding, which is deliberately dropped). NEVER enters `RerankOutcome`
 *  (decision 8). `dealbreakers` ride BOTH this (a prompt "avoid" line, governed by the rubric/synthesis
 *  clauses) AND the `toFilterPrefs` exclusions drop. The YoE band is the declared-level signal (the
 *  too-senior fix) — a categorical target_level was dropped as redundant/ambiguous. */
function toPromptPrefs(prefs: UserPreferencesRow): PromptPreferences {
  return {
    yoeMin: prefs.yoeMin,
    yoeMax: prefs.yoeMax,
    minSalary: prefs.minSalary,
    maxSalary: prefs.maxSalary,
    dealbreakers: prefs.dealbreakers,
  };
}

/**
 * The cron-able orchestrator. Opens a `digest_run`, resolves the recipient list (a single user when
 * `event.data.userId` is set — the manual/gate path — else every eligible user, keyset-swept), fans
 * out one `digest/user.requested` per recipient, and finalizes the run to the dispatch count. Because
 * Inngest fan-out is fire-and-forget, the run row records DISPATCH, not per-user completion (those land
 * on `digests`). A step that exhausts its retries is caught and terminalized onto the run row
 * (`status: 'error'` + `error_sample`) before the failure is rethrown to Inngest — so a dead run never
 * sits `running` forever. The cadence cron (`makeCadenceOrchestrator`) emits this with `trigger: 'cron'`;
 * the orchestrator then filters the recipient sweep by cadence (`listDigestRecipients`' `cadenceDue`, 12a-2).
 */
function makeOrchestrator(deps: DigestDeps) {
  return inngest.createFunction(
    { id: "digest-orchestrator" },
    { event: "digest/run.requested" },
    async ({ event, step }) => {
      const runId = await step.run("start-run", () => startDigestRun(deps.db, event.data.trigger));

      try {
        const recipients = await step.run("fetch-recipients", async (): Promise<string[]> => {
          const { userId } = event.data;
          if (userId !== undefined) {
            // Explicit undefined check + uuid gate: a truthiness check would silently widen a
            // malformed single-user payload (e.g. an empty string typed into the dev-server's
            // "Send event" form) into the all-recipients sweep below. Shape-only echo in the error.
            if (!UUID_RE.test(userId)) {
              throw new NonRetriableError(
                `digest: event userId is not a uuid (${userId.length} chars) — refusing to run.`,
              );
            }
            return [userId]; // single-user (the per-user fn skips if ineligible)
          }
          // The cadence cron (trigger='cron') filters to recipients whose cadence window has elapsed; a
          // manual run (trigger='manual', e.g. `pnpm digest --all`) sends to ALL eligible (cadence-agnostic).
          const cadenceDue = event.data.trigger === "cron";
          const ids: string[] = [];
          let afterId: UserId | undefined;
          for (;;) {
            const page = await listDigestRecipients(deps.db, {
              afterId,
              limit: RECIPIENT_CHUNK,
              cadenceDue,
            });
            for (const r of page) ids.push(r.userId);
            const last = page[page.length - 1];
            if (page.length < RECIPIENT_CHUNK || !last) break;
            afterId = last.userId;
          }
          return ids;
        });

        if (recipients.length > 0) {
          // One atomic fan-out (payload < 512 KB at this scale; paginate step.sendEvent beyond ~2.5k users).
          await step.sendEvent(
            "fan-out",
            recipients.map((userId) => ({
              name: "digest/user.requested" as const,
              data: { userId, digestRunId: runId },
            })),
          );
        }

        await step.run("finish-run", () =>
          finishDigestRun(deps.db, runId, {
            status: "ok",
            counts: { recipients: recipients.length, dispatched: recipients.length },
          }),
        );
        return { runId, recipients: recipients.length };
      } catch (err) {
        // A step above exhausted its retries (or threw NonRetriable). Terminalize the run row — this
        // is the write that makes `digest_runs.error_sample` real — then rethrow so Inngest still
        // records the failed run. Secret-free sample, same discipline as the discovery lane.
        await step.run("fail-run", () =>
          finishDigestRun(deps.db, runId, {
            status: "error",
            counts: {},
            errorSample: (err instanceof Error ? err.message : String(err)).slice(0, 500),
          }),
        );
        throw err;
      }
    },
  );
}

/**
 * The per-user digest. Steps (each memoized; the synthesis batch wait is the durable part):
 * load → retrieve → rerank (sync Haiku) → submit synthesis batch → sleep → poll → collect → persist
 * → send email → bounded delivery poll → record delivery (the Phase-11 tail, ./delivery).
 * `singleton` keyed on userId (mode `skip`) prevents overlapping runs for one user — `concurrency`
 * cannot: a run sleeping through the batch wait holds no concurrency slot, so a second run could read
 * the already-shown ids before the first persists. `skip` (not `cancel`) so an in-flight paid batch is
 * never abandoned. (Lock retention across `step.sleep` is undocumented but VERIFIED on the dev server
 * 2026-06-10: a second same-user event fired while run A slept in its batch wait produced no second
 * run, no second batch, and no duplicate digest — re-verify against Inngest Cloud when Phase 12's
 * production serve lands.) Phase 11 extends the held window PAST persist, through the delivery
 * sleeps (~2–12 min): a same-user re-trigger inside that tail is SKIPPED — the intended dedup, but a
 * `pnpm digest --user` retry fired inside it will time out waiting for a digest that never starts;
 * re-trigger after the run finishes in the dashboard. Returns a small JSON summary; per-user
 * failures surface to Inngest (orchestrator failures additionally land on the run row's
 * `error_sample`).
 */
function makePerUser(deps: DigestDeps) {
  return inngest.createFunction(
    { id: "digest-user", singleton: { key: "event.data.userId", mode: "skip" } },
    { event: "digest/user.requested" },
    async ({ event, step }) => {
      const userId = event.data.userId as UserId;
      const digestRunId = event.data.digestRunId;

      // 1. Load + gate eligibility (four independent userId-keyed reads → one Promise.all round).
      //    The gate runs HERE so BOTH the --all sweep (already filtered by listDigestRecipients) and
      //    the single-user/manual path skip a user who is unverified, disabled digests, or is
      //    suppressed (bounce/unsubscribe) — otherwise a manual trigger would spend tokens on, and
      //    pollute the already-shown history of, a user the sweep would skip. The profile EMBEDDING is
      //    deliberately not returned: it is consumed once, in retrieve — a 1024-dim vector is dead
      //    weight in memoized step state that every poll-loop replay re-ships.
      const loaded = await step.run("load", async () => {
        const [profile, prefs, excludeJobIds, excludeSignatures] = await Promise.all([
          getProfileForDigest(deps.db, userId),
          getPreferences(deps.db, userId),
          alreadyShownJobIds(deps.db, userId),
          alreadyShownSignatures(deps.db, userId),
        ]);
        if (!profile || !profile.embedding) return { skip: "no-profile-or-embedding" as const };
        if (
          !profile.emailVerified ||
          !prefs ||
          !prefs.digestEnabled ||
          prefs.digestSuppressedAt !== null
        ) {
          return { skip: "ineligible" as const };
        }
        return {
          structured: profile.structured,
          prefs: toFilterPrefs(prefs),
          promptPrefs: toPromptPrefs(prefs),
          excludeJobIds,
          excludeSignatures,
        };
      });
      if ("skip" in loaded) return { userId, skipped: loaded.skip };

      // 2. Deterministic filter + vector retrieval. Geo AND exclusion keywords are applied inside
      //    retrieval's post-filter (before its over-fetch trim — so exclusions can't empty the
      //    returned set while fetched non-excluded rows are thrown away). Re-reads the embedding here
      //    (one cheap row select) and returns only the fields + description length the rerank/synthesis
      //    prompts consume, keeping the memoized step output slim.
      const candidates = await step.run("retrieve", async (): Promise<RerankCandidate[]> => {
        const profile = await getProfileForDigest(deps.db, userId);
        if (!profile?.embedding) {
          throw new Error(`digest: profile embedding disappeared mid-run (user ${userId}).`);
        }
        const raw = await retrieveCandidatesForProfile(deps.db, profile.embedding, {
          limit: RETRIEVE_LIMIT,
          locationMode: loaded.prefs.locationMode,
          locations: loaded.prefs.locations,
          recencyDays: loaded.prefs.recencyDays,
          exclusions: loaded.prefs.exclusions,
          excludeJobIds: loaded.excludeJobIds,
          excludeSignatures: loaded.excludeSignatures,
        });
        return raw.map((c) => ({
          id: c.id,
          title: c.title,
          // +1 so a description that EXCEEDED the cap still trips the renderers' strict `> max`
          // checks and keeps their truncation marker; an exactly-capped slice would silently lose it.
          descriptionText: c.descriptionText.slice(0, DESCRIPTION_STATE_CHARS + 1),
        }));
      });
      if (candidates.length === 0) {
        // Considered this cadence period (nothing retrieved) — back off so the daily cron doesn't re-run.
        await step.run("mark-considered-no-candidates", () => markDigestConsidered(deps.db, userId));
        return { userId, skipped: "no-candidates" as const };
      }

      // 3. Sync rerank (Haiku, prompt-cached) → top-K, with the cache counters for the gate. No rank
      //    field here — persist re-ranks the reason-filtered survivors 1..N, and a rank in this shape
      //    would go stale the moment synthesis drops an item.
      const reranked = await step.run("rerank", async () => {
        const rr = await deps.rerank(loaded.structured, candidates, loaded.promptPrefs);
        // Apply the MIN_SCORE quality floor BEFORE the top-K cut: keep only items the reranker rated at
        // least "moderate", then take up to TOP_K. Fewer than TOP_K (or zero) is intended — a short honest
        // digest beats 12 padded with weak roles the note would disown. orderedIds is score-desc.
        const topIds = rr.orderedIds
          .filter((id) => (rr.scores.get(id) ?? 0) >= MIN_SCORE)
          .slice(0, TOP_K);
        return {
          items: topIds.map((id) => ({ jobId: id, score: rr.scores.get(id) ?? 0 })),
          cache: rr.cache,
        };
      });
      // No candidate cleared the quality floor — skip rather than send a digest of weak/bad-fit roles (or
      // an empty email). Distinct from "no-candidates": jobs matched here, but none scored well enough.
      if (reranked.items.length === 0) {
        // Considered this period (matches found, none cleared the floor) — back off after the PAID rerank.
        await step.run("mark-considered-no-strong", () => markDigestConsidered(deps.db, userId));
        return { userId, skipped: "no-strong-matches" as const };
      }

      // 4. Submit the synthesis batch (Sonnet, 50% discount): one request per kept item, cached
      //    rubric+profile system, custom_id = synthId(jobId) — the ONE key definition shared with the
      //    persist lookup (drift between the two would silently empty every digest).
      const synthId = (jobId: number) => `d${digestRunId}-${jobId}`;
      const byId = new Map(candidates.map((c) => [c.id, c]));
      const batchId = await step.run("submit-synthesis", async () => {
        const system = buildDigestSystem(loaded.structured, loaded.promptPrefs); // identical per item — build once
        const requests: BatchRequest[] = reranked.items.map((it) => {
          const job = byId.get(it.jobId);
          if (!job) {
            // Invariant: reranked ids are a permutation of the retrieved candidates. A miss means a
            // broken rerank — fail loudly rather than synthesize a blank job into a fabricated reason.
            throw new Error(`digest: reranked job ${it.jobId} is not in the candidate set (user ${userId}).`);
          }
          return {
            customId: synthId(it.jobId),
            model: "sonnet" as const,
            system,
            cacheSystem: true,
            maxOutputTokens: 256,
            messages: [{ role: "user" as const, content: renderDigestJob(job) }],
          };
        });
        const id = await deps.batch.submit(requests);
        // Logged INSIDE the step, before its result is memoized: step.run is at-least-once, so a crash
        // in the create→memoize window orphans this batch (the retry submits a fresh one) — this line
        // is the only durable handle for tracing/canceling the orphan's server-side spend.
        console.log(`digest: synthesis batch ${id} submitted (user ${userId}, run ${digestRunId})`);
        return id;
      });

      // 5. Durable poll: sleep, then poll on the bounded fast→slow schedule (see the tunables note) —
      //    ONE attempt's schedule covers the full 24h batch SLA, so no retry-budget machinery is
      //    needed. A bounded loop (not RetryAfterError, whose retries are capped at the function's ~4)
      //    is what lets the wait span the SLA.
      await step.sleep("synthesis-initial-wait", SYNTH_INITIAL_WAIT);
      let ended = false;
      for (let i = 0; i < SYNTH_MAX_POLLS; i++) {
        const poll = await step.run(`poll-synthesis-${i}`, () => deps.batch.poll(batchId));
        if (poll.status === "ended") {
          ended = true;
          break;
        }
        if (i < SYNTH_MAX_POLLS - 1) {
          await step.sleep(
            `synthesis-wait-${i}`,
            i < SYNTH_FAST_POLLS ? SYNTH_FAST_INTERVAL : SYNTH_SLOW_INTERVAL,
          );
        }
      }
      if (!ended) {
        throw new Error(
          `synthesis batch ${batchId} did not end within the ~24h poll window (${SYNTH_MAX_POLLS} polls) — ` +
            `it has expired server-side.`,
        );
      }

      // 6. Collect results into a serializable record (Map can't cross a step boundary).
      const reasons = await step.run("collect-synthesis", async () => {
        const map = await deps.batch.collect(batchId);
        const out: Record<string, { text: string; status: BatchResult["status"] }> = {};
        for (const [cid, r] of map) out[cid] = { text: r.text, status: r.status };
        return out;
      });

      // 7. Persist (retry-idempotent: delete any prior digest for this (user, run) — the FK cascade
      //    clears its items — then insert fresh). Drop items whose synthesis produced no usable reason
      //    (the gate requires non-empty reasons) and re-rank the survivors 1..N.
      const persisted = await step.run("persist", async () => {
        await deleteUserDigestForRun(deps.db, userId, digestRunId);
        const kept = reranked.items
          .map((it) => {
            const r = reasons[synthId(it.jobId)];
            const reason = r?.status === "succeeded" ? r.text.trim() : "";
            return { jobId: it.jobId, score: it.score, reason };
          })
          .filter((it) => it.reason.length > 0);

        if (kept.length === 0) {
          // Nothing usable out of an ATTEMPTED synthesis (every request errored/expired or trimmed to
          // empty) is a failure, not an empty digest — throw so Inngest surfaces it, instead of
          // returning "ok" with no digests row and no error trace anywhere in the DB.
          throw new Error(
            `digest: synthesis batch ${batchId} yielded no usable reason for any of ` +
              `${reranked.items.length} item(s) (user ${userId}, run ${digestRunId}).`,
          );
        }

        const { id: digestId } = await insertDigest(deps.db, {
          userId,
          digestRunId,
          itemCount: kept.length,
          counts: {
            candidates: candidates.length,
            reranked: reranked.items.length,
            rerankCacheReadTokens: reranked.cache.readInputTokens,
            rerankCacheCreationTokens: reranked.cache.creationInputTokens,
          },
        });
        await insertDigestItems(
          deps.db,
          digestId,
          userId,
          kept.map((it, i) => ({ jobId: it.jobId, rank: i + 1, score: it.score, reason: it.reason })),
        );
        return { userId, digestId, itemCount: kept.length };
      });

      // 7.5 F2 Arm C: liveness-probe the persisted items' apply URLs before send. DROP dead links (404/410)
      //     so the user never clicks Apply into a 404; soft-close on explicit 410 (count-only/shadow first —
      //     F2-enforce flips it on); KEEP ambiguous (2xx/3xx/5xx/timeout — never lose a possibly-live match
      //     over a blip). Re-reads applyUrl by digest id (not via step state). If EVERY item is dead, drop
      //     the whole digest and skip the send — the graceful no-send success, not an empty email.
      // F2-ENFORCE FLIP SITE 3 of 3 (also ingest.ts Arm A + discover.ts Arm B): add { enforce: true } as the
      // 5th arg here AND flip the other two together — no shared switch, so a partial flip silently leaves an
      // arm in shadow. (Arm C's DROP is already live in shadow; only its 410-CLOSE is gated by this flag.)
      const liveness = await probeDigestLiveness(
        { run: async (id, fn) => (await step.run(id, fn)) as Awaited<ReturnType<typeof fn>> },
        deps.db,
        deps.probe,
        persisted.digestId,
      );
      if (liveness.survivors === 0) {
        // Every apply URL was dead (404/410). The probe step already emptied digest_items, set item_count=0,
        // and folded the probe counts into digests.counts — so the 0-item digest row stays as audit (and keeps
        // the all-dead case visible to the shadow analysis); we just send no email. This is the graceful
        // no-send success, distinct from the persist step's throw for an empty SYNTHESIS.
        // Considered this period (a digest was built, every apply-URL was dead) — back off after the PAID
        // rerank + synthesis so the daily cron doesn't re-run the whole pipeline for them tomorrow.
        await step.run("mark-considered-all-dead", () => markDigestConsidered(deps.db, userId));
        return { userId, digestId: persisted.digestId, itemCount: 0, skipped: "all-items-dead" as const };
      }

      // 8. Email delivery (Phase 11): send (Idempotency-Key digest/<digestId>) → bounded delivery
      //    poll → record. The step block lives in ./delivery so the stub smoke can drive it with a
      //    fake step. The adapter below passes Inngest's tools through; the cast is sound — every
      //    step return in that block (SendDigestResult, string, void) is a JSON fixed-point, so
      //    Inngest's Jsonify memoization is the identity on them.
      const delivery = await deliverDigestEmail(
        {
          run: async (id, fn) => (await step.run(id, fn)) as Awaited<ReturnType<typeof fn>>,
          sleep: (id, duration) => step.sleep(id, duration),
        },
        deps.db,
        deps.email,
        persisted.digestId,
      );
      // Allowlist skip = a deliberate no-send (user not on EMAIL_ALLOWLIST); the send step never stamped
      // last_digest_sent_at, so back them off the cadence here (else the daily cron re-runs the paid pipeline
      // for a non-allowlisted user every tick). A real send already stamped via recordDigestSent.
      if (delivery === "skipped-allowlist") {
        await step.run("mark-considered-allowlist", () => markDigestConsidered(deps.db, userId));
      }
      return { ...persisted, delivery };
    },
  );
}

/**
 * The Phase-12 cadence cron (12a-2): a daily {cron} that EMITS `digest/run.requested {trigger:'cron'}`,
 * reusing the orchestrator's recipient sweep + fan-out. The orchestrator applies the cadence "due now"
 * predicate (only for trigger='cron'), so each user is sent on their own cadence (daily/weekly/monthly)
 * while the manual `pnpm digest --all` path stays cadence-agnostic. Emits only (no deps); all the work is
 * the orchestrator's. 13:00 UTC ≈ 8am US-Eastern (Inngest cron is UTC). The cadence WINDOWS that decide
 * "due" live in `listDigestRecipients` (db); change the FIRE TIME here.
 */
function makeCadenceOrchestrator() {
  return inngest.createFunction(
    { id: "digest-cadence", singleton: { mode: "skip" } },
    { cron: "0 13 * * *" },
    async ({ step }) => {
      await step.sendEvent("emit-cadence-run", {
        name: "digest/run.requested",
        data: { trigger: "cron" },
      });
      return { emitted: true };
    },
  );
}

/** The Inngest functions for the digest pipeline, wired to `deps`. Registered with the serve handler. */
export function createDigestFunctions(deps: DigestDeps) {
  return [makeOrchestrator(deps), makePerUser(deps), makeCadenceOrchestrator()];
}
