import type { Db } from "@opusfinder/db";
import {
  alreadyShownJobIds,
  deleteUserDigestForRun,
  finishDigestRun,
  getPreferences,
  getProfileForDigest,
  insertDigest,
  insertDigestItems,
  listDigestRecipients,
  retrieveCandidatesForProfile,
  startDigestRun,
  type UserPreferencesRow,
} from "@opusfinder/db/repos";
import { buildDigestSystem, renderDigestJob } from "@opusfinder/llm";
import type { BatchPoll, BatchRequest, BatchResult } from "@opusfinder/llm";
import type { RerankCandidate } from "@opusfinder/rerank";
import type { StructuredProfile, UserId } from "@opusfinder/shared";
import { NonRetriableError } from "inngest";

import { deliverDigestEmail, type EmailSeam } from "./delivery";
import { inngest } from "./inngest";

// --- Tunables (per-digest knobs) ---------------------------------------------------------------
const RETRIEVE_LIMIT = 50; // vector candidates pulled per user
const TOP_K = 12; // items reranked into the digest
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
  rerank: (profile: StructuredProfile, candidates: RerankCandidate[]) => Promise<RerankOutcome>;
  batch: {
    submit: (requests: BatchRequest[]) => Promise<string>;
    poll: (batchId: string) => Promise<BatchPoll>;
    collect: (batchId: string) => Promise<Map<string, BatchResult>>;
  };
  email: EmailSeam;
}

interface FilterPrefs {
  remoteOk: boolean;
  locations: string[];
  recencyDays: number;
  exclusions: string[];
}

/** The digest's filter inputs off a preferences row (all four columns are NOT NULL with schema
 *  defaults — the defaults live in ONE place, the schema). minSalary is intentionally omitted (no
 *  job-side salary column — Phase-10 decision). */
function toFilterPrefs(prefs: UserPreferencesRow): FilterPrefs {
  return {
    remoteOk: prefs.remoteOk,
    locations: prefs.locations,
    recencyDays: prefs.recencyDays,
    exclusions: prefs.exclusions,
  };
}

/**
 * The cron-able orchestrator. Opens a `digest_run`, resolves the recipient list (a single user when
 * `event.data.userId` is set — the manual/gate path — else every eligible user, keyset-swept), fans
 * out one `digest/user.requested` per recipient, and finalizes the run to the dispatch count. Because
 * Inngest fan-out is fire-and-forget, the run row records DISPATCH, not per-user completion (those land
 * on `digests`). A step that exhausts its retries is caught and terminalized onto the run row
 * (`status: 'error'` + `error_sample`) before the failure is rethrown to Inngest — so a dead run never
 * sits `running` forever. A cadence cron trigger is added in Phase 12 (with the deployed runtime).
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
          const ids: string[] = [];
          let afterId: UserId | undefined;
          for (;;) {
            const page = await listDigestRecipients(deps.db, { afterId, limit: RECIPIENT_CHUNK });
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

      // 1. Load + gate eligibility (three independent userId-keyed reads → one Promise.all round).
      //    The gate runs HERE so BOTH the --all sweep (already filtered by listDigestRecipients) and
      //    the single-user/manual path skip a user who is unverified, disabled digests, or is
      //    suppressed (bounce/unsubscribe) — otherwise a manual trigger would spend tokens on, and
      //    pollute the already-shown history of, a user the sweep would skip. The profile EMBEDDING is
      //    deliberately not returned: it is consumed once, in retrieve — a 1024-dim vector is dead
      //    weight in memoized step state that every poll-loop replay re-ships.
      const loaded = await step.run("load", async () => {
        const [profile, prefs, excludeJobIds] = await Promise.all([
          getProfileForDigest(deps.db, userId),
          getPreferences(deps.db, userId),
          alreadyShownJobIds(deps.db, userId),
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
        return { structured: profile.structured, prefs: toFilterPrefs(prefs), excludeJobIds };
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
          remoteOk: loaded.prefs.remoteOk,
          locations: loaded.prefs.locations,
          recencyDays: loaded.prefs.recencyDays,
          exclusions: loaded.prefs.exclusions,
          excludeJobIds: loaded.excludeJobIds,
        });
        return raw.map((c) => ({
          id: c.id,
          title: c.title,
          // +1 so a description that EXCEEDED the cap still trips the renderers' strict `> max`
          // checks and keeps their truncation marker; an exactly-capped slice would silently lose it.
          descriptionText: c.descriptionText.slice(0, DESCRIPTION_STATE_CHARS + 1),
        }));
      });
      if (candidates.length === 0) return { userId, skipped: "no-candidates" as const };

      // 3. Sync rerank (Haiku, prompt-cached) → top-K, with the cache counters for the gate. No rank
      //    field here — persist re-ranks the reason-filtered survivors 1..N, and a rank in this shape
      //    would go stale the moment synthesis drops an item.
      const reranked = await step.run("rerank", async () => {
        const rr = await deps.rerank(loaded.structured, candidates);
        const topIds = rr.orderedIds.slice(0, TOP_K);
        return {
          items: topIds.map((id) => ({ jobId: id, score: rr.scores.get(id) ?? 0 })),
          cache: rr.cache,
        };
      });

      // 4. Submit the synthesis batch (Sonnet, 50% discount): one request per kept item, cached
      //    rubric+profile system, custom_id = synthId(jobId) — the ONE key definition shared with the
      //    persist lookup (drift between the two would silently empty every digest).
      const synthId = (jobId: number) => `d${digestRunId}-${jobId}`;
      const byId = new Map(candidates.map((c) => [c.id, c]));
      const batchId = await step.run("submit-synthesis", async () => {
        const system = buildDigestSystem(loaded.structured); // identical per item — build once
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
      return { ...persisted, delivery };
    },
  );
}

/** The Inngest functions for the digest pipeline, wired to `deps`. Registered with the serve handler. */
export function createDigestFunctions(deps: DigestDeps) {
  return [makeOrchestrator(deps), makePerUser(deps)];
}
