/**
 * The digest's parity record: every step's output, every call to a paid or outward seam, and the rows left
 * behind, for a fixed set of inputs on a real (PGlite) database. `parity.fixture.json` holds the record the
 * Inngest-hosted stage code produced; the suite beside the stage code runs the same scenarios and must
 * reproduce it, whatever engine drives the steps.
 *
 * Only the seams are stubbed (rerank, the synthesis batch, email, the liveness probe). The repos, the
 * prompts and the stage code are the real ones. Timestamps are the one thing normalized.
 */
import { eq, sql } from "drizzle-orm";

import type { Db } from "@opusfinder/db";
import {
  closeJobsByIds,
  insertDigest,
  recordDigestSent,
  setDigestApproval,
  startDigestRun,
  upsertCompany,
  upsertJobs,
  writeJobEmbeddings,
  type DigestEmailPayload,
} from "@opusfinder/db/repos";
import {
  companies,
  digestItems,
  digestRuns,
  digests,
  jobs,
  user,
  userCvFiles,
  userPreferences,
  userProfiles,
} from "@opusfinder/db/schema";
import {
  companySlug,
  jobId,
  type DigestCadence,
  type DigestDelivery,
  type DigestTrigger,
  type PromptPreferences,
  type StructuredProfile,
  type UserId,
} from "@opusfinder/shared";

import { uid } from "../db/ids";
import { truncate } from "../db/truncate";
import { blend, oneHot, TEST_MODEL } from "../db/vectors";

/** One synthesis result, as the batch seam returns it (the shape of @opusfinder/llm's `BatchResult`, which
 *  this directory can't import). */
export interface ParityBatchResult {
  customId: string;
  status: "succeeded" | "errored";
  text: string;
  stopReason?: "end_turn" | "max_tokens" | null;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
}

/** The stubbed seams a scenario's deps are built from (the shape of the stage code's `DigestDeps`). */
export interface ParitySeams {
  db: Db;
  rerank: (
    profile: StructuredProfile,
    candidates: { id: number; title: string; descriptionText: string }[],
    prefs?: PromptPreferences,
  ) => Promise<{
    orderedIds: number[];
    scores: Map<number, number>;
    usage: { inputTokens: number; outputTokens: number; costUsd: number };
    cache: { creationInputTokens: number; readInputTokens: number };
  }>;
  batch: {
    submit: (requests: { customId: string }[]) => Promise<string>;
    poll: (batchId: string) => Promise<{
      status: "in_progress" | "ended";
      state: "in_progress" | "completed";
      counts: { total: number; completed: number; failed: number };
    }>;
    collect: (
      batchId: string,
    ) => Promise<{ results: Map<string, ParityBatchResult>; costUsd: number }>;
  };
  email: {
    send: (payload: DigestEmailPayload) => Promise<{ emailId: string }>;
    lastEvent: (emailId: string) => Promise<string>;
  };
  probe: (
    url: string,
  ) => Promise<{ verdict: "live" | "missing" | "gone" | "error"; status?: number }>;
  enforceLifecycle: boolean;
}

/** The step tools the stage code is handed: the union of what the orchestrator and the per-user run use. */
export interface ParityStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleep(id: string, duration: string): Promise<void>;
  sendEvent(id: string, events: unknown): Promise<void>;
}

/** One line of a scenario's log, in the order it happened. */
export type ParityEntry =
  | { step: string; output: unknown }
  | { step: string; threw: ParityError }
  | { sleep: string; duration: string }
  | { sendEvent: string; events: unknown }
  | { seam: string; input: unknown };

export interface ParityError {
  name: string;
  message: string;
  nonRetriable: boolean;
}

export interface ParityScenario {
  name: string;
  log: ParityEntry[];
  /** What the stage function returned, or the error it threw. */
  outcome: { returned: unknown } | { threw: ParityError };
  /** The rows the run left behind. */
  rows: unknown;
}

/** The stage code under test, and how its engine's step tools are built over the recorder. */
export interface ParityImpl<Deps> {
  buildDeps: (seams: ParitySeams) => Deps;
  runOrchestrator: (
    deps: Deps,
    event: { data: { trigger: DigestTrigger; userId?: string } },
    step: ParityStep,
  ) => Promise<unknown>;
  runPerUser: (
    deps: Deps,
    event: { data: { userId: string; digestRunId: number } },
    step: ParityStep,
  ) => Promise<unknown>;
  /** The error the batch seam throws for a batch that failed as a whole (@opusfinder/llm's
   *  `BatchEndedError`). */
  batchFailed: (batchId: string) => Error;
  /** Whether the engine must not retry `err`. */
  isNonRetriable: (err: unknown) => boolean;
  /** Wrap the recorder in an engine's step adapter (default: the stage code drives the recorder directly). */
  wrapStep?: (recorder: ParityStep) => ParityStep;
  /** Runs around each stage call, after the scenario is seeded and before its rows are read (e.g. to
   *  switch the connection to a limited database role and back). */
  around?: { enter: () => Promise<void>; leave: () => Promise<void> };
}

type OrchestratorCall = { trigger: DigestTrigger; userId?: string };

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** JSON, as a step result crosses a step boundary, with every timestamp replaced. */
function plain(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value ?? null, (_key, v: unknown) =>
      v instanceof Map ? Object.fromEntries(v) : v,
    ),
    (_key, v: unknown) => (typeof v === "string" && TIMESTAMP.test(v) ? "<timestamp>" : v),
  );
}

// ── Seeds ───────────────────────────────────────────────────────────────────────────────────────────

const USER = uid(1);
const STRUCTURED: StructuredProfile = {
  summary: "Backend engineer, eight years on payments systems.",
  skills: ["Go", "PostgreSQL", "Kafka"],
  targetRoles: ["Staff Backend Engineer"],
};

interface UserSeed {
  n?: number;
  emailVerified?: boolean;
  digestEnabled?: boolean;
  digestCadence?: DigestCadence;
  approved?: boolean;
  lastDigestSentAt?: Date | null;
  embedding?: number[] | null;
  dealbreakers?: string[];
  yoeMin?: number | null;
  /** Default `email`: when the record was made there was no setting, and a permitted account was emailed. */
  digestDelivery?: DigestDelivery;
}

async function seedUser(db: Db, seed: UserSeed = {}): Promise<UserId> {
  const n = seed.n ?? 1;
  const userId = uid(n);
  await db.insert(user).values({
    id: userId,
    name: `Tester ${n}`,
    email: `tester${n}@parity.test`,
    emailVerified: seed.emailVerified ?? true,
  });
  const cv = (
    await db
      .insert(userCvFiles)
      .values({
        userId,
        r2OriginalKey: `cv/original/${n}.pdf`,
        filename: `cv-${n}.pdf`,
        contentType: "application/pdf",
        byteSize: 1024,
      })
      .returning({ id: userCvFiles.id })
  )[0]!;
  const embedding = seed.embedding === undefined ? oneHot(0) : seed.embedding;
  await db.insert(userProfiles).values({
    userId,
    structured: STRUCTURED,
    embedding,
    embeddingModel: embedding === null ? null : TEST_MODEL,
    sourceCvFileId: cv.id,
  });
  await db.insert(userPreferences).values({
    userId,
    unsubscribeToken: `tok-${n}`,
    digestEnabled: seed.digestEnabled ?? true,
    digestCadence: seed.digestCadence ?? "weekly",
    digestDelivery: seed.digestDelivery ?? "email",
    digestApprovedAt: seed.approved === false ? null : new Date("2026-06-20T00:00:00Z"),
    lastDigestSentAt: seed.lastDigestSentAt ?? null,
    dealbreakers: seed.dealbreakers ?? [],
    yoeMin: seed.yoeMin ?? null,
  });
  return userId;
}

/** Four embedded jobs at distances 0, 0.04, 0.2 and 0.4 from the user's vector (ids 1–4, nearest first),
 *  and one with no vector (id 5), which retrieval never returns. */
async function seedJobs(db: Db): Promise<void> {
  const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
  const specs = [
    { ext: "a", title: "Staff Backend Engineer", vector: blend(1, 0) },
    { ext: "b", title: "Senior Payments Engineer", vector: blend(0.96, 0.28) },
    { ext: "c", title: "Platform Engineer", vector: blend(0.8, 0.6) },
    { ext: "d", title: "Data Engineer", vector: blend(0.6, 0.8) },
    { ext: "e", title: "Office Manager", vector: null },
  ];
  await upsertJobs(
    db,
    companyId,
    specs.map((s) => ({
      source: "greenhouse" as const,
      externalId: jobId(`ext-${s.ext}`),
      title: s.title,
      companySlug: companySlug("acme"),
      locations: ["Columbus, OH"],
      remote: s.ext === "b",
      descriptionText: `${s.title} at Acme. You will build and run the ${s.ext}-team's services.`,
      applyUrl: `https://jobs.parity.test/${s.ext}`,
      postedAt: null,
    })),
  );
  const rows = await db.select({ id: jobs.id, externalId: jobs.externalId }).from(jobs);
  const idOf = new Map<string, number>(rows.map((r) => [r.externalId as string, r.id]));
  await writeJobEmbeddings(
    db,
    specs.flatMap((s) =>
      s.vector ? [{ id: idOf.get(`ext-${s.ext}`)!, embedding: s.vector }] : [],
    ),
    TEST_MODEL,
  );
}

/** The rows a run can leave behind, in a stable order, timestamps as set/unset. */
async function readRows(db: Db): Promise<unknown> {
  const runs = await db
    .select({
      id: digestRuns.id,
      trigger: digestRuns.trigger,
      status: digestRuns.status,
      counts: digestRuns.counts,
      errorSample: digestRuns.errorSample,
      finished: sql<boolean>`${digestRuns.finishedAt} IS NOT NULL`,
    })
    .from(digestRuns)
    .orderBy(digestRuns.id);
  const digestRows = await db
    .select({
      id: digests.id,
      userId: digests.userId,
      digestRunId: digests.digestRunId,
      itemCount: digests.itemCount,
      counts: digests.counts,
      deliveryStatus: digests.deliveryStatus,
      emailId: digests.emailId,
      sent: sql<boolean>`${digests.sentAt} IS NOT NULL`,
    })
    .from(digests)
    .orderBy(digests.id);
  const items = await db
    .select({
      digestId: digestItems.digestId,
      jobId: digestItems.jobId,
      rank: digestItems.rank,
      score: digestItems.score,
      reason: digestItems.reason,
      jobTitle: digestItems.jobTitle,
      applyUrl: digestItems.applyUrl,
    })
    .from(digestItems)
    .orderBy(digestItems.digestId, digestItems.rank);
  const prefs = await db
    .select({
      userId: userPreferences.userId,
      cadenceStamped: sql<boolean>`${userPreferences.lastDigestSentAt} IS NOT NULL`,
      lastDigestEmailId: userPreferences.lastDigestEmailId,
      suppressed: sql<boolean>`${userPreferences.digestSuppressedAt} IS NOT NULL`,
      bounce: userPreferences.digestBounceStatus,
    })
    .from(userPreferences)
    .orderBy(userPreferences.userId);
  const closed = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.lifecycleState, "closed"))
    .orderBy(jobs.id);
  return plain({
    digestRuns: runs,
    digests: digestRows,
    digestItems: items,
    preferences: prefs,
    closedJobs: closed.map((j) => j.id),
  });
}

// ── Seams ───────────────────────────────────────────────────────────────────────────────────────────

/** What a scenario's stubs answer. Every field has the happy-path default. */
interface Script {
  /** Rerank score per job id (default 0.9, 0.8, 0.7, 0.3 for jobs 1–4). An empty map scores nothing. */
  scores?: Record<number, number>;
  /** Poll answers in order; the last repeats (default: ended at once). `throw` fails that poll. */
  polls?: ("in_progress" | "ended" | "throw")[];
  /** Runs before the first poll: where a scenario changes the world during the batch wait. */
  duringWait?: (db: Db) => Promise<void>;
  /** Synthesis result per job id (default: a succeeded note for every request). */
  synthesis?: Record<number, Partial<ParityBatchResult>>;
  /** Collect throws: the batch failed as a whole. */
  batchFailed?: true;
  /** Probe verdict per apply-URL suffix (default: live). */
  probes?: Record<string, { verdict: "live" | "missing" | "gone" | "error"; status?: number }>;
  /** `email.send` throws. */
  sendThrows?: boolean;
  /** Resend `last_event` answers in order; the last repeats (default: delivered). */
  events?: string[];
  enforceLifecycle?: boolean;
}

function buildSeams(
  db: Db,
  script: Script,
  log: ParityEntry[],
  batchFailed: (batchId: string) => Error,
): ParitySeams {
  const scores = script.scores ?? { 1: 0.9, 2: 0.8, 3: 0.7, 4: 0.3 };
  let polled = 0;
  let eventsRead = 0;
  const seam = (name: string, input: unknown) => log.push({ seam: name, input: plain(input) });
  return {
    db,
    enforceLifecycle: script.enforceLifecycle ?? false,
    rerank: async (profile, candidates, prefs) => {
      seam("rerank", { profile, candidateIds: candidates.map((c) => c.id), prefs });
      const scored = candidates.filter((c) => scores[c.id] !== undefined);
      const ordered = [...scored].sort((a, b) => scores[b.id]! - scores[a.id]!);
      return {
        orderedIds: [
          ...ordered.map((c) => c.id),
          ...candidates.filter((c) => scores[c.id] === undefined).map((c) => c.id),
        ],
        scores: new Map(scored.map((c) => [c.id, scores[c.id]!])),
        usage: { inputTokens: 1200, outputTokens: 80, costUsd: 0.0031 },
        cache: { creationInputTokens: 900, readInputTokens: 300 },
      };
    },
    batch: {
      submit: async (requests) => {
        seam("batch.submit", requests);
        return "batch-parity-1";
      },
      poll: async (batchId) => {
        if (polled === 0) await script.duringWait?.(db);
        const polls = script.polls ?? ["ended"];
        const answer = polls[Math.min(polled, polls.length - 1)]!;
        polled++;
        seam("batch.poll", { batchId, answer });
        if (answer === "throw") throw new Error("batch poll failed: 503");
        return {
          status: answer,
          state: answer === "ended" ? ("completed" as const) : ("in_progress" as const),
          counts: { total: 0, completed: 0, failed: 0 },
        };
      },
      collect: async (batchId) => {
        seam("batch.collect", { batchId });
        if (script.batchFailed) throw batchFailed(batchId);
        const results = new Map<string, ParityBatchResult>();
        // The custom id is d<run>-<job>; the stage code owns that format, so results are keyed off the
        // ids the submit received.
        for (const entry of log) {
          if (!("seam" in entry) || entry.seam !== "batch.submit") continue;
          for (const request of entry.input as { customId: string }[]) {
            const job = Number(request.customId.split("-")[1]);
            results.set(request.customId, {
              customId: request.customId,
              status: "succeeded",
              text: `Job ${job} fits: it asks for the payments background the profile has.`,
              stopReason: "end_turn",
              usage: {
                inputTokens: 400,
                outputTokens: 50,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 350,
              },
              ...script.synthesis?.[job],
            });
          }
        }
        return { results, costUsd: 0.0124 };
      },
    },
    email: {
      send: async (payload) => {
        seam("email.send", payload);
        if (script.sendThrows) throw new Error("Resend send failed: application_error (500)");
        return { emailId: "email-parity-1" };
      },
      lastEvent: async (emailId) => {
        const events = script.events ?? ["delivered"];
        const event = events[Math.min(eventsRead, events.length - 1)]!;
        eventsRead++;
        seam("email.lastEvent", { emailId, event });
        return event;
      },
    },
    probe: async (url) => {
      const outcome = script.probes?.[url.slice(url.lastIndexOf("/") + 1)] ?? {
        verdict: "live" as const,
        status: 200,
      };
      seam("probe", { url, outcome });
      return outcome;
    },
  };
}

function recorder(log: ParityEntry[], describe: (err: unknown) => ParityError): ParityStep {
  return {
    run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
      let output: unknown;
      try {
        output = plainStepResult(await fn());
      } catch (err) {
        log.push({ step: id, threw: describe(err) });
        throw err;
      }
      log.push({ step: id, output: plain(output) });
      return output as T;
    },
    sleep: async (id, duration) => {
      log.push({ sleep: id, duration });
    },
    sendEvent: async (id, events) => {
      log.push({ sendEvent: id, events: plain(events) });
    },
  };
}

/** What later code is handed for a step's result: its JSON, as an engine replays it (dates kept as their
 *  strings; only the log normalizes them). */
function plainStepResult(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

// ── Scenarios ───────────────────────────────────────────────────────────────────────────────────────

export interface ScenarioSpec {
  name: string;
  script?: Script;
  /** May return the run the per-user call belongs to (default: a run opened after seeding). */
  seed: (db: Db) => Promise<void | { digestRunId: number }>;
  /** The stage call: `perUser` or `orchestrator` with its event data. */
  call: { perUser: true } | { orchestrator: { trigger: DigestTrigger; userId?: string } };
}

const userAndJobs = async (db: Db, seed: UserSeed = {}) => {
  await seedUser(db, seed);
  await seedJobs(db);
};

const SCENARIOS: ScenarioSpec[] = [
  // ---- the per-user run ----
  {
    name: "per-user: digest built, emailed and delivered",
    seed: (db) => userAndJobs(db, { dealbreakers: ["clearance"], yoeMin: 5 }),
    call: { perUser: true },
  },
  {
    name: "per-user: this run's digest was already emailed",
    seed: async (db) => {
      await userAndJobs(db);
      const digestRunId = await startDigestRun(db, "cron");
      const { id } = await insertDigest(db, {
        userId: USER,
        digestRunId,
        itemCount: 1,
        counts: {},
      });
      await recordDigestSent(db, id, "email-earlier");
      return { digestRunId };
    },
    call: { perUser: true },
  },
  {
    name: "per-user: profile has no vector",
    seed: (db) => userAndJobs(db, { embedding: null }),
    call: { perUser: true },
  },
  {
    name: "per-user: digests switched off",
    seed: (db) => userAndJobs(db, { digestEnabled: false }),
    call: { perUser: true },
  },
  {
    name: "per-user: no send permit",
    seed: (db) => userAndJobs(db, { approved: false }),
    call: { perUser: true },
  },
  {
    name: "per-user: nothing retrieved",
    seed: async (db) => {
      await seedUser(db);
    },
    call: { perUser: true },
  },
  {
    name: "per-user: nothing above the score floor",
    script: { scores: { 1: 0.4, 2: 0.3, 3: 0.2, 4: 0.1 } },
    seed: (db) => userAndJobs(db),
    call: { perUser: true },
  },
  {
    name: "per-user: rerank scored nothing",
    script: { scores: {} },
    seed: (db) => userAndJobs(db),
    call: { perUser: true },
  },
  {
    name: "per-user: a failed poll is waited out, then the batch ends",
    script: { polls: ["in_progress", "throw", "in_progress", "ended"] },
    seed: (db) => userAndJobs(db),
    call: { perUser: true },
  },
  {
    name: "per-user: six failed polls in a row give up on the batch",
    script: { polls: ["throw"] },
    seed: (db) => userAndJobs(db),
    call: { perUser: true },
  },
  {
    name: "per-user: the batch never ends",
    script: { polls: ["in_progress"] },
    seed: (db) => userAndJobs(db),
    call: { perUser: true },
  },
  {
    name: "per-user: the batch failed as a whole",
    script: { batchFailed: true },
    seed: (db) => userAndJobs(db),
    call: { perUser: true },
  },
  {
    name: "per-user: synthesis drops some notes; probe drops a 404 and a 410 (not enforcing); bounce",
    script: {
      synthesis: { 3: { status: "errored", text: "", error: "overloaded_error" } },
      probes: { a: { verdict: "missing", status: 404 }, b: { verdict: "gone", status: 410 } },
      scores: { 1: 0.9, 2: 0.8, 3: 0.7, 4: 0.6 },
      events: ["sent", "bounced"],
    },
    seed: (db) => userAndJobs(db),
    call: { perUser: true },
  },
  {
    name: "per-user: no note is usable (cut off, linked, empty)",
    script: {
      synthesis: {
        1: { stopReason: "max_tokens" },
        2: { text: "Apply at https://evil.test/now" },
        3: { text: "   " },
      },
    },
    seed: (db) => userAndJobs(db),
    call: { perUser: true },
  },
  {
    name: "per-user: every apply link is dead; a 410 closes its job (enforcing)",
    script: {
      enforceLifecycle: true,
      probes: {
        a: { verdict: "gone", status: 410 },
        b: { verdict: "missing", status: 404 },
        c: { verdict: "missing", status: 404 },
      },
    },
    seed: (db) => userAndJobs(db),
    call: { perUser: true },
  },
  {
    name: "per-user: permit revoked during the batch wait",
    script: {
      duringWait: async (db) => {
        await setDigestApproval(db, USER, false);
      },
    },
    seed: (db) => userAndJobs(db),
    call: { perUser: true },
  },
  {
    name: "per-user: digests switched off during the batch wait",
    script: {
      duringWait: async (db) => {
        await db
          .update(userPreferences)
          .set({ digestEnabled: false })
          .where(eq(userPreferences.userId, USER));
      },
    },
    seed: (db) => userAndJobs(db),
    call: { perUser: true },
  },
  {
    name: "per-user: every kept job closed during the batch wait",
    script: {
      duringWait: async (db) => {
        await closeJobsByIds(db, [1, 2, 3], { enforce: true });
      },
    },
    seed: (db) => userAndJobs(db),
    call: { perUser: true },
  },
  {
    name: "per-user: the send fails",
    script: { sendThrows: true },
    seed: (db) => userAndJobs(db),
    call: { perUser: true },
  },
  {
    name: "per-user: delivery still in flight after both polls",
    script: { events: ["sent", "delivery_delayed"] },
    seed: (db) => userAndJobs(db),
    call: { perUser: true },
  },
  // ---- the orchestrator ----
  {
    name: "orchestrator: the cron run fans out to the users who are due",
    seed: async (db) => {
      await seedUser(db, { n: 1 }); // never sent: due
      await seedUser(db, { n: 2, lastDigestSentAt: new Date(Date.now() - 2 * 86_400_000) }); // weekly, 2 days ago
      await seedUser(db, { n: 3, lastDigestSentAt: new Date(Date.now() - 8 * 86_400_000) }); // due
      await seedUser(db, { n: 4, approved: false });
      await seedUser(db, { n: 5, embedding: null });
      await seedUser(db, {
        n: 6,
        digestCadence: "daily",
        lastDigestSentAt: new Date(Date.now() - 21 * 3_600_000),
      }); // due
    },
    call: { orchestrator: { trigger: "cron" } },
  },
  {
    name: "orchestrator: nobody is due",
    seed: async (db) => {
      await seedUser(db, { n: 1, lastDigestSentAt: new Date(Date.now() - 86_400_000) });
    },
    call: { orchestrator: { trigger: "cron" } },
  },
  {
    name: "orchestrator: a manual run takes every eligible user, due or not",
    seed: async (db) => {
      await seedUser(db, { n: 1, lastDigestSentAt: new Date(Date.now() - 86_400_000) });
      await seedUser(db, { n: 2 });
    },
    call: { orchestrator: { trigger: "manual" } },
  },
  {
    name: "orchestrator: a single-user run lowercases the id",
    seed: async (db) => {
      await seedUser(db, { n: 1 });
    },
    call: { orchestrator: { trigger: "manual", userId: USER.toUpperCase() } },
  },
  {
    name: "orchestrator: a malformed user id fails the run",
    seed: async (db) => {
      await seedUser(db, { n: 1 });
    },
    call: { orchestrator: { trigger: "manual", userId: "" } },
  },
];

/**
 * The main path for an account with the given delivery setting. Not part of the parity record (the setting
 * is newer than it): the logs-only suite runs it and reads the log and the rows.
 */
export function deliveryScenario(digestDelivery: DigestDelivery): ScenarioSpec {
  return {
    name: `per-user: account delivery is ${digestDelivery}`,
    seed: (db) => userAndJobs(db, { digestDelivery }),
    call: { perUser: true },
  };
}

/**
 * Run every scenario against `impl` on `db` (emptied before each) and return the record. With the default
 * scenarios, compare it with `parity.fixture.json`.
 */
export async function recordParity<Deps>(
  db: Db,
  impl: ParityImpl<Deps>,
  scenarios: ScenarioSpec[] = SCENARIOS,
): Promise<ParityScenario[]> {
  const describe = (err: unknown): ParityError => ({
    name: err instanceof Error ? err.name : typeof err,
    message: err instanceof Error ? err.message : String(err),
    nonRetriable: impl.isNonRetriable(err),
  });
  const record: ParityScenario[] = [];
  for (const spec of scenarios) {
    await truncate(
      db,
      digestItems,
      digests,
      digestRuns,
      userPreferences,
      userProfiles,
      userCvFiles,
      jobs,
      companies,
      user,
    );
    const seeded = await spec.seed(db);
    const log: ParityEntry[] = [];
    const deps = impl.buildDeps(buildSeams(db, spec.script ?? {}, log, impl.batchFailed));
    const base = recorder(log, describe);
    const step = impl.wrapStep ? impl.wrapStep(base) : base;
    let outcome: ParityScenario["outcome"];
    const digestRunId =
      "perUser" in spec.call
        ? (seeded?.digestRunId ?? (await startDigestRun(db, "cron")))
        : undefined;
    await impl.around?.enter();
    try {
      const returned =
        digestRunId !== undefined
          ? await impl.runPerUser(deps, { data: { userId: USER, digestRunId } }, step)
          : await impl.runOrchestrator(
              deps,
              { data: (spec.call as { orchestrator: OrchestratorCall }).orchestrator },
              step,
            );
      outcome = { returned: plain(returned) };
    } catch (err) {
      outcome = { threw: describe(err) };
    } finally {
      await impl.around?.leave();
    }
    record.push({ name: spec.name, log, outcome, rows: await readRows(db) });
  }
  return record;
}
