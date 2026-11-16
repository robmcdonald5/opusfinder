/**
 * A logs-only digest on PGlite, through the real stage code and repos: built and stored in full, never
 * handed to the email seam, never marked sent, and the user's cadence slot taken. Two ways in: the
 * account's delivery setting, and the stage's logs-only mode (which overrides an `email` account).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Db } from "@opusfinder/db";
import { BatchEndedError } from "@opusfinder/llm";

import { createTestDb } from "@test/db/pglite";
import {
  deliveryScenario,
  recordParity,
  type ParityImpl,
  type ParityScenario,
} from "@test/digest/parity";

import { runOrchestrator, runPerUser, type DigestDeps } from "./digest";
import { NonRetriableError } from "./errors";

function impl(logsOnly?: () => Promise<boolean>): ParityImpl<DigestDeps> {
  return {
    buildDeps: (seams) => ({ ...seams, logsOnly }),
    runOrchestrator,
    runPerUser,
    batchFailed: (batchId) => new BatchEndedError(batchId, "failed", "provider error"),
    isNonRetriable: (err) => err instanceof NonRetriableError,
  };
}

const steps = (scenario: ParityScenario) =>
  scenario.log.flatMap((entry) => ("step" in entry ? [entry.step] : []));
const seamCalls = (scenario: ParityScenario) =>
  scenario.log.flatMap((entry) => ("seam" in entry ? [entry.seam] : []));

/** A digest stored in full and not sent, with the user's cadence slot taken and no email id. */
const STORED_NOT_SENT = {
  digests: [
    expect.objectContaining({ itemCount: 3, deliveryStatus: "none", emailId: null, sent: false }),
  ],
  digestItems: [
    expect.objectContaining({ jobId: 1, rank: 1 }),
    expect.objectContaining({ jobId: 2, rank: 2 }),
    expect.objectContaining({ jobId: 3, rank: 3 }),
  ],
  preferences: [expect.objectContaining({ cadenceStamped: true, lastDigestEmailId: null })],
};

describe("logs-only digests", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await close?.();
  });

  it("an account set to logs gets its digest built and stored, and nothing is sent", async () => {
    const [scenario] = await recordParity(db, impl(), [deliveryScenario("logs")]);

    expect(scenario!.outcome).toEqual({
      returned: expect.objectContaining({ itemCount: 3, delivery: "skipped-logs-only" }),
    });
    // The whole paid pipeline ran; the send step ended the run without a send.
    expect(steps(scenario!)).toEqual([
      "load-v2",
      "retrieve-v2",
      "rerank",
      "submit-synthesis",
      "poll-synthesis-0",
      "collect-synthesis",
      "persist",
      "liveness-probe",
      "send-email",
      "mark-considered-logs-only",
    ]);
    expect(seamCalls(scenario!)).not.toContain("email.send");
    expect(scenario!.rows).toMatchObject(STORED_NOT_SENT);
  });

  it("the stage's logs-only mode overrides an account set to email", async () => {
    const [scenario] = await recordParity(
      db,
      impl(async () => true),
      [deliveryScenario("email")],
    );

    expect(scenario!.outcome).toEqual({
      returned: expect.objectContaining({ delivery: "skipped-logs-only" }),
    });
    expect(seamCalls(scenario!)).not.toContain("email.send");
    expect(scenario!.rows).toMatchObject(STORED_NOT_SENT);
  });

  it("with the stage on, an account set to email is sent", async () => {
    const [scenario] = await recordParity(
      db,
      impl(async () => false),
      [deliveryScenario("email")],
    );

    expect(scenario!.outcome).toEqual({
      returned: expect.objectContaining({ delivery: "delivered" }),
    });
    expect(seamCalls(scenario!)).toContain("email.send");
  });

  it("an account set to logs is never sent, even with the stage on", async () => {
    const [scenario] = await recordParity(
      db,
      impl(async () => false),
      [deliveryScenario("logs")],
    );

    expect(seamCalls(scenario!)).not.toContain("email.send");
    expect(scenario!.rows).toMatchObject(STORED_NOT_SENT);
  });

  it("a stage mode that can't be read fails the send step and sends nothing", async () => {
    const unreadable = () => Promise.reject(new Error("control plane unreadable"));
    const [scenario] = await recordParity(db, impl(unreadable), [deliveryScenario("email")]);

    expect(scenario!.outcome).toEqual({
      threw: expect.objectContaining({ message: "control plane unreadable", nonRetriable: false }),
    });
    expect(seamCalls(scenario!)).not.toContain("email.send");
  });
});
