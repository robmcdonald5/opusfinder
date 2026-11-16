/**
 * Checks the digest's parity record (test/digest/parity.ts): every step's output, every seam call and the
 * rows left behind, for fixed inputs on PGlite. The committed fixture was recorded from the stage code as
 * it ran on Inngest, before it moved here; this code has to reproduce it.
 *
 * Re-record (only when the stages are meant to change): RECORD_DIGEST_PARITY=1 vitest run <this file>.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Db } from "@opusfinder/db";
import { BatchEndedError } from "@opusfinder/llm";

import { createTestDb } from "@test/db/pglite";
import { recordParity, type ParityScenario } from "@test/digest/parity";

import { runOrchestrator, runPerUser, type DigestDeps } from "./digest";
import { NonRetriableError } from "./errors";

const FIXTURE = fileURLToPath(new URL("../../../test/digest/parity.fixture.json", import.meta.url));

describe("digest stages — parity record", () => {
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

  it("every step output, seam call and row matches the committed record", async () => {
    const record = await recordParity<DigestDeps>(db, {
      buildDeps: (seams) => seams,
      runOrchestrator,
      runPerUser,
      batchFailed: (batchId) => new BatchEndedError(batchId, "failed", "provider error"),
      isNonRetriable: (err) => err instanceof NonRetriableError,
    });
    if (process.env.RECORD_DIGEST_PARITY === "1") {
      writeFileSync(FIXTURE, `${JSON.stringify(record, null, 2)}\n`);
    }
    const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as ParityScenario[];
    expect(record.map((s) => s.name)).toEqual(expected.map((s) => s.name));
    for (const [i, scenario] of record.entries()) {
      expect(scenario, scenario.name).toEqual(expected[i]);
    }
  }, 60_000);
});
