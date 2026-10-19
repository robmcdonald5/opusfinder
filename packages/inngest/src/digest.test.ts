/**
 * Unit suite for the two digest orchestrators (src/digest.ts `runOrchestrator` + `runPerUser`), extracted
 * from their Inngest handlers so a recording fake `step` + stubbed repos drive them. NO creds, NO Neon, NO
 * LLM. `@opusfinder/db/repos` and `@opusfinder/llm` are mocked; the already-tested sub-functions
 * (`probeDigestLiveness`, `deliverDigestEmail`) are mocked to isolate ORCHESTRATION — which steps fire, the
 * skip-reason matrix, fan-out, and the invariant throws — from their internals (covered in probe/delivery).
 */
import { DrizzleQueryError } from "drizzle-orm";
import { NonRetriableError, serializeError, StepError } from "inngest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DigestTrigger } from "@opusfinder/shared";

import { recordingStep } from "@test/inngest/stubs";
import { rejectionOf } from "@test/rejection";

const repos = vi.hoisted(() => ({
  // per-user
  getProfileForDigest: vi.fn(),
  getPreferences: vi.fn(),
  alreadyShownJobIds: vi.fn(),
  alreadyShownSignatures: vi.fn(),
  retrieveCandidatesForProfile: vi.fn(),
  markDigestConsidered: vi.fn(),
  hasSentDigestForRun: vi.fn(),
  deleteUserDigestForRun: vi.fn(),
  insertDigest: vi.fn(),
  getJobSnapshots: vi.fn(),
  insertDigestItems: vi.fn(),
  // orchestrator
  startDigestRun: vi.fn(),
  listDigestRecipients: vi.fn(),
  finishDigestRun: vi.fn(),
}));
vi.mock("@opusfinder/db/repos", () => repos);

const llm = vi.hoisted(() => ({
  buildDigestSystem: vi.fn(),
  renderDigestJob: vi.fn(),
  BatchEndedError: class BatchEndedError extends Error {},
}));
vi.mock("@opusfinder/llm", () => llm);

const probeMod = vi.hoisted(() => ({ probeDigestLiveness: vi.fn() }));
vi.mock("./probe", () => probeMod);

const deliveryMod = vi.hoisted(() => ({ deliverDigestEmail: vi.fn() }));
vi.mock("./delivery", () => deliveryMod);

import { runOrchestrator, runPerUser, type DigestDeps } from "./digest";

// ── Shared deps (the injected seams; per-user sub-functions are module-mocked above) ────────────────
const rerank = vi.fn();
const batchSubmit = vi.fn();
const batchPoll = vi.fn();
const batchCollect = vi.fn();
const email = { send: vi.fn(), lastEvent: vi.fn() };
const probe = vi.fn();

/** Collect resolves to these results plus the batch total OpenRouter charged. */
function mockCollect(results: Map<string, unknown>): void {
  batchCollect.mockResolvedValue({ results, costUsd: 0.004 });
}

function makeDeps(enforceLifecycle = false): DigestDeps {
  return {
    db: {} as never,
    rerank,
    batch: { submit: batchSubmit, poll: batchPoll, collect: batchCollect },
    email,
    probe,
    enforceLifecycle,
  };
}

const USER = "user-1";
const RUN_ID = 99;

beforeEach(() => {
  vi.resetAllMocks();
  // ---- per-user HAPPY defaults (each test overrides one seam to reach a branch) ----
  repos.getProfileForDigest.mockResolvedValue({
    structured: { skills: [] },
    embedding: [0.1],
    emailVerified: true,
  });
  repos.getPreferences.mockResolvedValue({
    digestEnabled: true,
    digestSuppressedAt: null,
    digestApprovedAt: new Date("2026-01-01"),
    locationMode: "any",
    locations: [],
    recencyDays: 30,
    exclusions: [],
    dealbreakers: [],
    yoeMin: null,
    yoeMax: null,
    minSalary: null,
    maxSalary: null,
  });
  repos.alreadyShownJobIds.mockResolvedValue([]);
  repos.alreadyShownSignatures.mockResolvedValue([]);
  repos.retrieveCandidatesForProfile.mockResolvedValue([
    { id: 1, title: "Eng", descriptionText: "d1" },
    { id: 2, title: "Eng2", descriptionText: "d2" },
  ]);
  repos.markDigestConsidered.mockResolvedValue(undefined);
  repos.hasSentDigestForRun.mockResolvedValue(false);
  repos.deleteUserDigestForRun.mockResolvedValue(undefined);
  repos.insertDigest.mockResolvedValue({ id: 500 });
  repos.getJobSnapshots.mockResolvedValue(new Map([[1, {}], [2, {}]]));
  repos.insertDigestItems.mockResolvedValue(undefined);
  llm.buildDigestSystem.mockReturnValue("SYSTEM");
  llm.renderDigestJob.mockReturnValue("RENDERED");
  rerank.mockResolvedValue({
    orderedIds: [1, 2],
    scores: new Map([
      [1, 0.9],
      [2, 0.8],
    ]),
    usage: { inputTokens: 300, outputTokens: 40, costUsd: 0.003 },
    cache: { creationInputTokens: 10, readInputTokens: 20 },
  });
  batchSubmit.mockResolvedValue("batch-1");
  batchPoll.mockResolvedValue({ status: "ended" });
  const synthUsage = {
    inputTokens: 100,
    outputTokens: 30,
    cacheCreationInputTokens: 5,
    cacheReadInputTokens: 7,
  };
  mockCollect(
    new Map([
      [
        `d${RUN_ID}-1`,
        { text: "reason one", status: "succeeded", stopReason: "end_turn", usage: synthUsage },
      ],
      [
        `d${RUN_ID}-2`,
        { text: "reason two", status: "succeeded", stopReason: "end_turn", usage: synthUsage },
      ],
    ]),
  );
  probeMod.probeDigestLiveness.mockResolvedValue({ survivors: 2, counts: {} });
  deliveryMod.deliverDigestEmail.mockResolvedValue("delivered");
  // ---- orchestrator defaults ----
  repos.startDigestRun.mockResolvedValue(42);
  repos.finishDigestRun.mockResolvedValue(undefined);
  repos.listDigestRecipients.mockResolvedValue([]);
});

// ════════════════════════════════════════ runOrchestrator ══════════════════════════════════════════
describe("runOrchestrator", () => {
  function event(data: { trigger: DigestTrigger; userId?: string }) {
    return { data };
  }
  const UUID = "11111111-1111-4111-8111-111111111111";

  it("single valid-UUID user → fans out one event + finishes ok, no recipient sweep", async () => {
    const { runs, sentEvents, tools } = recordingStep();

    const out = await runOrchestrator(makeDeps(), event({ trigger: "manual", userId: UUID }), tools);

    expect(repos.listDigestRecipients).not.toHaveBeenCalled(); // single-user path skips the sweep
    expect(sentEvents).toEqual([
      {
        id: "fan-out",
        events: [{ name: "digest/user.requested", data: { userId: UUID, digestRunId: 42 } }],
      },
    ]);
    expect(repos.finishDigestRun).toHaveBeenCalledWith(expect.anything(), 42, {
      status: "ok",
      counts: { recipients: 1, dispatched: 1 },
    });
    expect(out).toEqual({ runId: 42, recipients: 1 });
    expect(runs).toEqual(["start-run", "fetch-recipients", "finish-run"]);
  });

  it("lowercases an uppercase single-user UUID, so the per-user singleton key matches the cron's", async () => {
    const lower = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const { sentEvents, tools } = recordingStep();

    await runOrchestrator(makeDeps(), event({ trigger: "manual", userId: lower.toUpperCase() }), tools);

    expect(sentEvents[0]!.events).toEqual([
      { name: "digest/user.requested", data: { userId: lower, digestRunId: 42 } },
    ]);
  });

  it("malformed single-user payload (empty string) → NonRetriableError, no fan-out, run terminalized", async () => {
    const { runs, sentEvents, tools } = recordingStep();

    await expect(
      runOrchestrator(makeDeps(), event({ trigger: "manual", userId: "" }), tools),
    ).rejects.toThrow(/not a uuid/);

    expect(sentEvents).toEqual([]);
    expect(repos.listDigestRecipients).not.toHaveBeenCalled(); // never widened into the all-users sweep
    expect(repos.finishDigestRun).toHaveBeenCalledTimes(1);
    expect(repos.finishDigestRun).toHaveBeenCalledWith(
      expect.anything(),
      42,
      expect.objectContaining({ status: "error", errorSample: expect.stringContaining("not a uuid") }),
    );
    expect(runs).toEqual(["start-run", "fetch-recipients", "fail-run"]);
  });

  it("cron trigger passes cadenceDue:true to the recipient sweep", async () => {
    repos.listDigestRecipients.mockResolvedValue([{ userId: UUID }]);
    const { tools } = recordingStep();

    await runOrchestrator(makeDeps(), event({ trigger: "cron" }), tools);

    expect(repos.listDigestRecipients).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cadenceDue: true }),
    );
  });

  it("manual trigger passes cadenceDue:false to the recipient sweep", async () => {
    repos.listDigestRecipients.mockResolvedValue([{ userId: UUID }]);
    const { tools } = recordingStep();

    await runOrchestrator(makeDeps(), event({ trigger: "manual" }), tools);

    expect(repos.listDigestRecipients).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cadenceDue: false }),
    );
  });

  it("zero recipients → no fan-out, run still finishes ok with 0 counts", async () => {
    repos.listDigestRecipients.mockResolvedValue([]);
    const { sentEvents, tools } = recordingStep();

    const out = await runOrchestrator(makeDeps(), event({ trigger: "cron" }), tools);

    expect(sentEvents).toEqual([]);
    expect(repos.finishDigestRun).toHaveBeenCalledWith(expect.anything(), 42, {
      status: "ok",
      counts: { recipients: 0, dispatched: 0 },
    });
    expect(out).toEqual({ runId: 42, recipients: 0 });
  });

  it("keyset-sweeps across pages until a short page, fanning out every recipient", async () => {
    // A full RECIPIENT_CHUNK (200) page forces a second query keyed after its last id; a short page stops.
    const fullPage = Array.from({ length: 200 }, (_v, i) => ({ userId: `u${i}` }));
    const shortPage = [{ userId: "u200" }];
    repos.listDigestRecipients.mockResolvedValueOnce(fullPage).mockResolvedValueOnce(shortPage);
    const { sentEvents, tools } = recordingStep();

    const out = await runOrchestrator(makeDeps(), event({ trigger: "manual" }), tools);

    expect(repos.listDigestRecipients).toHaveBeenCalledTimes(2);
    expect(repos.listDigestRecipients).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ afterId: "u199" }), // keyed after the full page's last id
    );
    expect(out.recipients).toBe(201);
    expect((sentEvents[0]!.events as unknown[]).length).toBe(201);
  });

  it("terminalizes a swept-step failure onto the run row with a sliced error sample, then rethrows", async () => {
    const longMessage = "boom ".repeat(300); // > 500 chars → must be sliced
    repos.listDigestRecipients.mockRejectedValue(new Error(longMessage));
    const { runs, tools } = recordingStep();

    await expect(
      runOrchestrator(makeDeps(), event({ trigger: "cron" }), tools),
    ).rejects.toThrow(/boom/);

    const failCall = repos.finishDigestRun.mock.calls.at(-1)!;
    expect(failCall[2]).toMatchObject({ status: "error" });
    expect((failCall[2] as { errorSample: string }).errorSample).toHaveLength(500);
    expect(runs).toContain("fail-run");
  });

  it("records a failed query's Postgres reason, never its params line, when it arrives as a StepError", async () => {
    // As production sees it: the step's DrizzleQueryError, serialized by Inngest once its retries ran out and
    // re-thrown as a StepError — drizzle's message and the cause's message survive; the class, `query` and the
    // cause's fields (this `code`) do not, so the sample carries no `[code=…]`.
    const cause = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    const query = 'select "user_id" from "user_preferences"';
    const failed = new DrizzleQueryError(query, ["secret-user-data"], cause);
    const stepError = new StepError("fetch-recipients", serializeError(failed));
    repos.listDigestRecipients.mockRejectedValue(stepError);
    const { tools } = recordingStep();

    await expect(runOrchestrator(makeDeps(), event({ trigger: "cron" }), tools)).rejects.toThrow();

    const failCall = repos.finishDigestRun.mock.calls.at(-1)!;
    expect((failCall[2] as { errorSample: string }).errorSample).toBe(
      `canceling statement due to statement timeout | Failed query: ${query}`,
    );
  });
});

// ════════════════════════════════════════ runPerUser ═══════════════════════════════════════════════
describe("runPerUser", () => {
  function event() {
    return { data: { userId: USER, digestRunId: RUN_ID } };
  }

  it("happy path: full pipeline → delivered, correct step sequence + digestId", async () => {
    const { runs, sleeps, tools } = recordingStep();

    const out = await runPerUser(makeDeps(), event(), tools);

    expect(out).toEqual({ userId: USER, digestId: 500, itemCount: 2, delivery: "delivered" });
    expect(runs).toEqual([
      "load",
      "retrieve",
      "rerank",
      "submit-synthesis",
      "poll-synthesis-0",
      "collect-synthesis",
      "persist",
    ]);
    // Per-digest spend: rerank usage as reported, synthesis usage summed over the batch's results, and
    // the synthesis cost as the batch total.
    expect(repos.insertDigest.mock.calls[0]![1].counts).toEqual({
      candidates: 2,
      reranked: 2,
      rerankScored: 2,
      rerankInputTokens: 300,
      rerankOutputTokens: 40,
      rerankCacheReadTokens: 20,
      rerankCacheCreationTokens: 10,
      rerankCostUsd: 0.003,
      synthesisInputTokens: 200,
      synthesisOutputTokens: 60,
      synthesisCacheReadTokens: 14,
      synthesisCacheCreationTokens: 10,
      synthesisCostUsd: 0.004,
    });
    expect(sleeps).toEqual(["synthesis-initial-wait"]); // poll ended first tick → no synthesis-wait
    expect(probeMod.probeDigestLiveness).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      500,
      { enforce: false },
    );
    expect(deliveryMod.deliverDigestEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      500,
    );
  });

  it("passes the enforce flag through to the liveness probe", async () => {
    const { tools } = recordingStep();
    await runPerUser(makeDeps(true), event(), tools);
    expect(probeMod.probeDigestLiveness).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      500,
      { enforce: true },
    );
  });

  it("defaults enforce to false when deps omit enforceLifecycle (the ?? false fallback)", async () => {
    // makeDeps always sets the flag explicitly; build deps WITHOUT it so the `?? false` default is the value
    // that reaches the probe. An explicit `false` cannot tell `?? false` apart from `?? true`.
    const deps: DigestDeps = {
      db: {} as never,
      rerank,
      batch: { submit: batchSubmit, poll: batchPoll, collect: batchCollect },
      email,
      probe,
    };
    const { tools } = recordingStep();

    await runPerUser(deps, event(), tools);

    expect(probeMod.probeDigestLiveness).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      500,
      { enforce: false },
    );
  });

  it("skips with no-profile-or-embedding when the profile is missing — only the load step runs", async () => {
    repos.getProfileForDigest.mockResolvedValue(null);
    const { runs, tools } = recordingStep();

    const out = await runPerUser(makeDeps(), event(), tools);

    expect(out).toEqual({ userId: USER, skipped: "no-profile-or-embedding" });
    expect(runs).toEqual(["load"]);
    expect(rerank).not.toHaveBeenCalled();
  });

  it("skips no-profile-or-embedding when the profile is present but its embedding is null", async () => {
    // The OTHER half of the load gate's OR (`!profile.embedding`): the profile row exists but its embedding
    // column is null (e.g. not yet backfilled). Must skip at load, NOT fall through to the retrieve step's
    // disappeared-mid-run throw.
    repos.getProfileForDigest.mockResolvedValue({
      structured: { skills: [] },
      embedding: null,
      emailVerified: true,
    });
    const { runs, tools } = recordingStep();

    const out = await runPerUser(makeDeps(), event(), tools);

    expect(out).toEqual({ userId: USER, skipped: "no-profile-or-embedding" });
    expect(runs).toEqual(["load"]);
    expect(repos.retrieveCandidatesForProfile).not.toHaveBeenCalled();
  });

  it.each([
    ["emailVerified false", { emailVerified: false }, {}],
    ["digestEnabled false", {}, { digestEnabled: false }],
    ["suppressed", {}, { digestSuppressedAt: new Date("2026-02-01") }],
  ])("skips ineligible (%s)", async (_label, profileOver, prefsOver) => {
    repos.getProfileForDigest.mockResolvedValue({
      structured: { skills: [] },
      embedding: [0.1],
      emailVerified: true,
      ...profileOver,
    });
    repos.getPreferences.mockResolvedValue({
      digestEnabled: true,
      digestSuppressedAt: null,
      digestApprovedAt: new Date("2026-01-01"),
      locationMode: "any",
      locations: [],
      recencyDays: 30,
      exclusions: [],
      dealbreakers: [],
      yoeMin: null,
      yoeMax: null,
      minSalary: null,
      maxSalary: null,
      ...prefsOver,
    });
    const { runs, tools } = recordingStep();

    const out = await runPerUser(makeDeps(), event(), tools);

    expect(out).toEqual({ userId: USER, skipped: "ineligible" });
    expect(runs).toEqual(["load"]);
  });

  it("skips ineligible when the preferences row is missing (null)", async () => {
    // The `!prefs` sub-branch of the eligibility gate: a user with a profile but no preferences row must skip
    // gracefully, NOT crash dereferencing prefs.digestEnabled. getPreferences returns `... | null` in prod.
    repos.getPreferences.mockResolvedValue(null);
    const { runs, tools } = recordingStep();

    const out = await runPerUser(makeDeps(), event(), tools);

    expect(out).toEqual({ userId: USER, skipped: "ineligible" });
    expect(runs).toEqual(["load"]);
    expect(rerank).not.toHaveBeenCalled();
  });

  it("skips not-approved when the send permit (digestApprovedAt) is null — before any paid spend", async () => {
    repos.getPreferences.mockResolvedValue({
      digestEnabled: true,
      digestSuppressedAt: null,
      digestApprovedAt: null,
      locationMode: "any",
      locations: [],
      recencyDays: 30,
      exclusions: [],
      dealbreakers: [],
      yoeMin: null,
      yoeMax: null,
      minSalary: null,
      maxSalary: null,
    });
    const { runs, tools } = recordingStep();

    const out = await runPerUser(makeDeps(), event(), tools);

    expect(out).toEqual({ userId: USER, skipped: "not-approved" });
    expect(runs).toEqual(["load"]);
    expect(rerank).not.toHaveBeenCalled();
  });

  it("skips already-sent when this run already emailed the user — a full Rerun spends and deletes nothing", async () => {
    repos.hasSentDigestForRun.mockResolvedValue(true);
    const { runs, tools } = recordingStep();

    const out = await runPerUser(makeDeps(), event(), tools);

    expect(out).toEqual({ userId: USER, skipped: "already-sent" });
    expect(runs).toEqual(["load"]);
    expect(rerank).not.toHaveBeenCalled();
    expect(repos.deleteUserDigestForRun).not.toHaveBeenCalled();
  });

  it("persist refuses to replace an emailed digest when a rerun starts past load", async () => {
    // A "Rerun from step" restores load's memoized result, so only persist's own check sees the sent row.
    repos.hasSentDigestForRun.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { tools } = recordingStep();

    const err = await rejectionOf(runPerUser(makeDeps(), event(), tools));

    expect(err).toBeInstanceOf(NonRetriableError);
    expect(err.message).toMatch(/already emailed/);
    expect(repos.deleteUserDigestForRun).not.toHaveBeenCalled();
    expect(repos.insertDigest).not.toHaveBeenCalled();
    expect(deliveryMod.deliverDigestEmail).not.toHaveBeenCalled();
  });

  it("throws when the profile embedding disappears between the load and retrieve reads", async () => {
    // Load reads a valid embedding-bearing profile (passes the gate); the retrieve step RE-READS and finds the
    // embedding gone (a mid-run delete/re-embed race) → the disappeared-mid-run invariant must fire. Needs two
    // once-values because a single mockResolvedValue would return the same profile to both reads.
    const validProfile = { structured: { skills: [] }, embedding: [0.1], emailVerified: true };
    repos.getProfileForDigest
      .mockResolvedValueOnce(validProfile) // load read
      .mockResolvedValueOnce({ ...validProfile, embedding: null }); // retrieve re-read
    const { runs, tools } = recordingStep();

    await expect(runPerUser(makeDeps(), event(), tools)).rejects.toThrow(
      /profile embedding disappeared mid-run/,
    );
    expect(runs).toEqual(["load", "retrieve"]);
    expect(repos.retrieveCandidatesForProfile).not.toHaveBeenCalled();
  });

  it("skips no-candidates and backs off when retrieval is empty", async () => {
    repos.retrieveCandidatesForProfile.mockResolvedValue([]);
    const { runs, tools } = recordingStep();

    const out = await runPerUser(makeDeps(), event(), tools);

    expect(out).toEqual({ userId: USER, skipped: "no-candidates" });
    expect(runs).toEqual(["load", "retrieve", "mark-considered-no-candidates"]);
    expect(rerank).not.toHaveBeenCalled();
  });

  it("skips no-strong-matches when every reranked item is below MIN_SCORE", async () => {
    rerank.mockResolvedValue({
      orderedIds: [1, 2],
      scores: new Map([
        [1, 0.4],
        [2, 0.3],
      ]),
      usage: { inputTokens: 300, outputTokens: 40, costUsd: 0.003 },
      cache: { creationInputTokens: 10, readInputTokens: 20 },
    });
    const { runs, tools } = recordingStep();

    const out = await runPerUser(makeDeps(), event(), tools);

    expect(out).toEqual({ userId: USER, skipped: "no-strong-matches" });
    expect(runs).toEqual(["load", "retrieve", "rerank", "mark-considered-no-strong"]);
    expect(batchSubmit).not.toHaveBeenCalled();
  });

  it("throws, without backing the user off, when the rerank scored no candidate", async () => {
    rerank.mockResolvedValue({
      orderedIds: [1, 2], // the core's backfilled permutation, with nothing scored
      scores: new Map(),
      usage: { inputTokens: 300, outputTokens: 40, costUsd: 0.003 },
      cache: { creationInputTokens: 10, readInputTokens: 20 },
    });
    const { tools } = recordingStep();

    await expect(runPerUser(makeDeps(), event(), tools)).rejects.toThrow(
      /rerank scored none of 2 candidate/,
    );
    expect(repos.markDigestConsidered).not.toHaveBeenCalled();
    expect(batchSubmit).not.toHaveBeenCalled();
  });

  it("all items dead → skips send, records a 0-item digest, backs off", async () => {
    probeMod.probeDigestLiveness.mockResolvedValue({ survivors: 0, counts: {} });
    const { runs, tools } = recordingStep();

    const out = await runPerUser(makeDeps(), event(), tools);

    expect(out).toEqual({ userId: USER, digestId: 500, itemCount: 0, skipped: "all-items-dead" });
    expect(runs).toContain("mark-considered-all-dead");
    expect(deliveryMod.deliverDigestEmail).not.toHaveBeenCalled();
  });

  it("delivery skipped-unapproved → marks considered, returns the delivery status", async () => {
    deliveryMod.deliverDigestEmail.mockResolvedValue("skipped-unapproved");
    const { runs, tools } = recordingStep();

    const out = await runPerUser(makeDeps(), event(), tools);

    expect(out).toEqual({ userId: USER, digestId: 500, itemCount: 2, delivery: "skipped-unapproved" });
    expect(runs).toContain("mark-considered-unapproved");
  });

  it("delivery skipped-empty → marks considered-all-closed", async () => {
    deliveryMod.deliverDigestEmail.mockResolvedValue("skipped-empty");
    const { runs, tools } = recordingStep();

    const out = await runPerUser(makeDeps(), event(), tools);

    expect(out).toEqual({ userId: USER, digestId: 500, itemCount: 2, delivery: "skipped-empty" });
    expect(runs).toContain("mark-considered-all-closed");
  });

  it("throws the permutation invariant when a reranked id is not a retrieved candidate", async () => {
    rerank.mockResolvedValue({
      orderedIds: [999],
      scores: new Map([[999, 0.9]]),
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      cache: { creationInputTokens: 0, readInputTokens: 0 },
    });
    const { tools } = recordingStep();

    const err = await rejectionOf(runPerUser(makeDeps(), event(), tools));

    expect(err).toBeInstanceOf(NonRetriableError);
    expect(err.message).toMatch(/reranked job 999 is not in the candidate set/);
    expect(batchSubmit).not.toHaveBeenCalled();
  });

  it("polls past the 24h batch expiry before giving up on a batch that never ends", async () => {
    batchPoll.mockResolvedValue({ status: "in_progress" }); // never 'ended'
    const { sleepCalls, tools } = recordingStep();

    const err = await rejectionOf(runPerUser(makeDeps(), event(), tools));

    expect(err).toBeInstanceOf(NonRetriableError);
    expect(err.message).toMatch(/had not ended after 171 polls/);
    expect(batchPoll).toHaveBeenCalledTimes(171); // SYNTH_MAX_POLLS (30 fast + 141 slow)
    // The API ends an expired batch at 24h, so the last poll must land after that to collect it.
    const minutes = (d = "") => (d.endsWith("s") ? parseInt(d) / 60 : parseInt(d));
    const lastPollAt = sleepCalls.reduce((sum, s) => sum + minutes(s.duration), 0);
    expect(lastPollAt).toBeGreaterThan(24 * 60);
  });

  it("rides out failed synthesis polls and collects once the batch ends", async () => {
    const outage = new Error("overloaded");
    batchPoll
      .mockRejectedValueOnce(outage)
      .mockRejectedValueOnce(outage)
      .mockRejectedValueOnce(outage)
      .mockRejectedValueOnce(outage)
      .mockRejectedValueOnce(outage) // five in a row: one short of giving up
      .mockResolvedValueOnce({ status: "in_progress" }) // a success resets the run
      .mockRejectedValueOnce(outage)
      .mockResolvedValueOnce({ status: "ended" });
    const { runs, tools } = recordingStep();

    const out = await runPerUser(makeDeps(), event(), tools);

    expect(out).toEqual({ userId: USER, digestId: 500, itemCount: 2, delivery: "delivered" });
    expect(batchPoll).toHaveBeenCalledTimes(8);
    expect(runs).toContain("collect-synthesis");
  });

  it("gives up after six consecutive failed polls", async () => {
    const outage = new Error("unauthorized");
    batchPoll.mockRejectedValue(outage);
    const { tools } = recordingStep();

    const err = await rejectionOf(runPerUser(makeDeps(), event(), tools));

    expect(err).toBe(outage);
    expect(batchPoll).toHaveBeenCalledTimes(6);
    expect(batchCollect).not.toHaveBeenCalled();
  });

  it("polls on the fast (2m) schedule for the first hour, then the slow (10m) tail", async () => {
    // Stay in_progress through poll i=30 (so synthesis-wait-30 is emitted), then end at i=31. The sleep id
    // encodes only the loop index, so the DURATION is what pins the fast→slow boundary (i < SYNTH_FAST_POLLS).
    let polls = 0;
    batchPoll.mockImplementation(async () =>
      polls++ < 31 ? { status: "in_progress" } : { status: "ended" },
    );
    const { sleepCalls, tools } = recordingStep();

    await runPerUser(makeDeps(), event(), tools);

    expect(batchPoll).toHaveBeenCalledTimes(32);
    const durationById = new Map(sleepCalls.map((s) => [s.id, s.duration]));
    expect(durationById.get("synthesis-initial-wait")).toBe("30s");
    expect(durationById.get("synthesis-wait-0")).toBe("2m"); // fast band
    expect(durationById.get("synthesis-wait-29")).toBe("2m"); // last fast (i=29 < 30)
    expect(durationById.get("synthesis-wait-30")).toBe("10m"); // first slow (i=30, not < 30)
  });

  it("fails the run without retries when the batch ended without results", async () => {
    batchCollect.mockRejectedValue(new llm.BatchEndedError("batch batch-1 is expired, not completed"));
    const { tools } = recordingStep();

    const err = await rejectionOf(runPerUser(makeDeps(), event(), tools));

    expect(err).toBeInstanceOf(NonRetriableError);
    expect(err.message).toBe("batch batch-1 is expired, not completed");
    expect(repos.insertDigest).not.toHaveBeenCalled();
  });

  it("throws when synthesis yields no usable reason for any item, naming each drop reason", async () => {
    mockCollect(
      new Map([
        [`d${RUN_ID}-1`, { text: "  ", status: "succeeded", stopReason: "end_turn" }], // trimmed empty
        [`d${RUN_ID}-2`, { text: "", status: "errored", error: "overloaded_error" }], // non-succeeded
      ]),
    );
    const { tools } = recordingStep();

    const err = await rejectionOf(runPerUser(makeDeps(), event(), tools));

    expect(err).toBeInstanceOf(NonRetriableError);
    expect(err.message).toMatch(
      /no usable reason for any of 2 item\(s\) .*: empty=1, overloaded_error=1\.$/,
    );
    expect(repos.insertDigest).not.toHaveBeenCalled();
  });

  it("drops a note cut off at max_tokens even though its request succeeded", async () => {
    mockCollect(
      new Map([
        [
          `d${RUN_ID}-1`,
          { text: "You match because your Go and", status: "succeeded", stopReason: "max_tokens" },
        ],
        [`d${RUN_ID}-2`, { text: "reason two", status: "succeeded", stopReason: "end_turn" }],
      ]),
    );
    const { tools } = recordingStep();

    const out = await runPerUser(makeDeps(), event(), tools);

    expect(out).toMatchObject({ itemCount: 1 });
    const items = repos.insertDigestItems.mock.calls.at(-1)![3] as Array<{ jobId: number }>;
    expect(items.map((it) => it.jobId)).toEqual([2]);
  });

  it("partial synthesis: drops the reason-less item and renumbers the lone survivor to rank 1", async () => {
    // job 1's synthesis errored (dropped by the reason filter); job 2 succeeded. job 2 was index 1 pre-filter,
    // so it must be RENUMBERED to rank 1 — the only test that exercises the kept-map renumbering (i + 1) with
    // a hole punched in the middle (the all-keep and all-drop tests can't observe i + 1 vs i).
    mockCollect(
      new Map([
        [`d${RUN_ID}-1`, { text: "reason one", status: "errored" }], // non-succeeded → dropped
        [`d${RUN_ID}-2`, { text: "reason two", status: "succeeded", stopReason: "end_turn" }], // survives
      ]),
    );
    const { tools } = recordingStep();

    const out = await runPerUser(makeDeps(), event(), tools);

    expect(out).toEqual({ userId: USER, digestId: 500, itemCount: 1, delivery: "delivered" });
    expect(repos.insertDigest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ itemCount: 1 }),
    );
    const items = repos.insertDigestItems.mock.calls.at(-1)![3] as Array<{ jobId: number; rank: number }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ jobId: 2, rank: 1 }); // renumbered from its pre-filter index of 1
  });

  it.each([
    "You should confirm your fit at https://evil.example/verify before applying.",
    "Your Go work fits; see www.evil.example for the next step.",
    "Your Go work fits; send your CV to jobs@evil.example to be fast-tracked.",
  ])("drops a note carrying a link or email address: %s", async (injected) => {
    mockCollect(
      new Map([
        [`d${RUN_ID}-1`, { text: injected, status: "succeeded", stopReason: "end_turn" }],
        [
          `d${RUN_ID}-2`,
          {
            text: "Your Node.js and ASP.NET work at Acme fits.",
            status: "succeeded",
            stopReason: "end_turn",
          },
        ],
      ]),
    );
    const { tools } = recordingStep();

    const out = await runPerUser(makeDeps(), event(), tools);

    expect(out).toMatchObject({ itemCount: 1 });
    const items = repos.insertDigestItems.mock.calls.at(-1)![3] as Array<{ jobId: number }>;
    expect(items.map((it) => it.jobId)).toEqual([2]);
  });

  it("throws the snapshot invariant when a kept job has no snapshot", async () => {
    repos.getJobSnapshots.mockResolvedValue(new Map([[1, {}]])); // missing job 2
    const { tools } = recordingStep();

    const err = await rejectionOf(runPerUser(makeDeps(), event(), tools));

    expect(err).toBeInstanceOf(NonRetriableError);
    expect(err.message).toMatch(/no job snapshot for kept job 2/);
  });
});
