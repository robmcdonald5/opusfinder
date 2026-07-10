/**
 * Unit suite for the two digest orchestrators (src/digest.ts `runOrchestrator` + `runPerUser`), extracted
 * from their Inngest handlers so a recording fake `step` + stubbed repos drive them. NO creds, NO Neon, NO
 * LLM. `@opusfinder/db/repos` and `@opusfinder/llm` are mocked; the already-tested sub-functions
 * (`probeDigestLiveness`, `deliverDigestEmail`) are mocked to isolate ORCHESTRATION — which steps fire, the
 * skip-reason matrix, fan-out, and the invariant throws — from their internals (covered in probe/delivery).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DigestTrigger } from "@opusfinder/shared";

import { recordingStep } from "@test/inngest/stubs";

const repos = vi.hoisted(() => ({
  // per-user
  getProfileForDigest: vi.fn(),
  getPreferences: vi.fn(),
  alreadyShownJobIds: vi.fn(),
  alreadyShownSignatures: vi.fn(),
  retrieveCandidatesForProfile: vi.fn(),
  markDigestConsidered: vi.fn(),
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

const llm = vi.hoisted(() => ({ buildDigestSystem: vi.fn(), renderDigestJob: vi.fn() }));
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
    cache: { creationInputTokens: 10, readInputTokens: 20 },
  });
  batchSubmit.mockResolvedValue("batch-1");
  batchPoll.mockResolvedValue({ status: "ended" });
  batchCollect.mockResolvedValue(
    new Map([
      [`d${RUN_ID}-1`, { text: "reason one", status: "succeeded" }],
      [`d${RUN_ID}-2`, { text: "reason two", status: "succeeded" }],
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

  it("skips with no-profile-or-embedding when the profile is missing — only the load step runs", async () => {
    repos.getProfileForDigest.mockResolvedValue(null);
    const { runs, tools } = recordingStep();

    const out = await runPerUser(makeDeps(), event(), tools);

    expect(out).toEqual({ userId: USER, skipped: "no-profile-or-embedding" });
    expect(runs).toEqual(["load"]);
    expect(rerank).not.toHaveBeenCalled();
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
      cache: { creationInputTokens: 10, readInputTokens: 20 },
    });
    const { runs, tools } = recordingStep();

    const out = await runPerUser(makeDeps(), event(), tools);

    expect(out).toEqual({ userId: USER, skipped: "no-strong-matches" });
    expect(runs).toEqual(["load", "retrieve", "rerank", "mark-considered-no-strong"]);
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
      cache: { creationInputTokens: 0, readInputTokens: 0 },
    });
    const { tools } = recordingStep();

    await expect(runPerUser(makeDeps(), event(), tools)).rejects.toThrow(
      /reranked job 999 is not in the candidate set/,
    );
    expect(batchSubmit).not.toHaveBeenCalled();
  });

  it("throws when the synthesis batch never ends within the poll window", async () => {
    batchPoll.mockResolvedValue({ status: "in_progress" }); // never 'ended'
    const { tools } = recordingStep();

    await expect(runPerUser(makeDeps(), event(), tools)).rejects.toThrow(
      /did not end within the ~24h poll window/,
    );
    expect(batchPoll).toHaveBeenCalledTimes(168); // SYNTH_MAX_POLLS (30 fast + 138 slow)
  });

  it("throws when synthesis yields no usable reason for any item", async () => {
    batchCollect.mockResolvedValue(
      new Map([
        [`d${RUN_ID}-1`, { text: "  ", status: "succeeded" }], // whitespace → trimmed empty
        [`d${RUN_ID}-2`, { text: "x", status: "errored" }], // non-succeeded → dropped
      ]),
    );
    const { tools } = recordingStep();

    await expect(runPerUser(makeDeps(), event(), tools)).rejects.toThrow(/no usable reason/);
    expect(repos.insertDigest).not.toHaveBeenCalled();
  });

  it("throws the snapshot invariant when a kept job has no snapshot", async () => {
    repos.getJobSnapshots.mockResolvedValue(new Map([[1, {}]])); // missing job 2
    const { tools } = recordingStep();

    await expect(runPerUser(makeDeps(), event(), tools)).rejects.toThrow(
      /no job snapshot for kept job 2/,
    );
  });
});
