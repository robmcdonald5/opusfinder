/**
 * The digest Worker (apps/digest) connects as the digest_worker role. Everything it runs must succeed AS
 * that role, since a missing grant fails a query: the whole parity record (every path of the orchestrator
 * and the per-user run), the health check with an alert sent and recorded, and the fan-out's record of
 * each user's last run. The role's exact grants are audited in packages/db/src/roles.integration.test.ts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Db } from "@opusfinder/db";
import {
  countLocalStrings,
  getDigestInstances,
  retrieveCandidatesForProfile,
  setDigestInstance,
} from "@opusfinder/db/repos";
import { DIGEST_WORKER } from "@opusfinder/db/roles";
import { healthAlerts, user, userCvFiles, userPreferences } from "@opusfinder/db/schema";
import { BatchEndedError } from "@opusfinder/llm";

import { uid } from "@test/db/ids";
import { createTestDb } from "@test/db/pglite";
import { setUpRole } from "@test/db/role";
import { truncate } from "@test/db/truncate";
import { oneHot, tagged } from "@test/db/vectors";
import { recordParity, type ParityScenario } from "@test/digest/parity";

import { runOrchestrator, runPerUser, type DigestDeps } from "./digest";
import { NonRetriableError } from "./errors";
import { runHealthCheck } from "./health-check";

const FIXTURE = fileURLToPath(new URL("../../../test/digest/parity.fixture.json", import.meta.url));

describe("the digest Worker's work as digest_worker (integration: real PGlite semantics)", () => {
  let db: Db;
  let pg: PGlite;
  let close: (() => Promise<void>) | undefined;
  const asRole = {
    enter: () => pg.exec(`SET ROLE ${DIGEST_WORKER.name}`).then(() => undefined),
    leave: () => pg.exec("RESET ROLE").then(() => undefined),
  };

  beforeAll(async () => {
    ({ db, client: pg, close } = await createTestDb());
    await setUpRole(pg, DIGEST_WORKER);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await asRole.leave();
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await close?.();
  });

  it("every path of the orchestrator and the per-user run reproduces the parity record", async () => {
    const reject = () => Promise.reject(new Error("the location model is not part of this record"));
    const record = await recordParity<DigestDeps>(db, {
      buildDeps: (seams) => ({
        ...seams,
        locations: { generate: reject, submitBatch: reject, collectBatch: reject },
      }),
      runOrchestrator,
      runPerUser,
      batchFailed: (batchId) => new BatchEndedError(batchId, "failed", "provider error"),
      isNonRetriable: (err) => err instanceof NonRetriableError,
      around: asRole,
    });

    const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as ParityScenario[];
    for (const [i, scenario] of record.entries()) {
      expect(scenario, scenario.name).toEqual(expected[i]);
    }
    expect(JSON.stringify(record)).not.toContain("permission denied");
  }, 60_000);

  it("the health check runs, sends an alert and records it; the next run finds it in the cooldown", async () => {
    await truncate(db, healthAlerts);
    const send = vi.fn(async () => ({ emailId: "email-alert-1" }));
    const deps = {
      db,
      // No ingestion run has ever succeeded here, so this check fires.
      healthOptions: { modes: { ingestion_staleness: "enforce" as const } },
      send,
      cooldownH: 24,
    };

    await asRole.enter();
    const first = await runHealthCheck(deps);
    const second = await runHealthCheck(deps);

    expect(first).toMatchObject({
      unhealthy: true,
      firing: ["ingestion_staleness"],
      notified: ["ingestion_staleness"],
      emailId: "email-alert-1",
    });
    expect(second).toMatchObject({ notified: [], suppressed: ["ingestion_staleness"] });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("the fan-out records and reads each user's last run", async () => {
    await truncate(db, userPreferences, userCvFiles, user);
    await db.insert(user).values([
      { id: uid(1), name: "A", email: "a@role.test", emailVerified: true },
      { id: uid(2), name: "B", email: "b@role.test", emailVerified: true },
    ]);
    await db.insert(userPreferences).values([
      { userId: uid(1), unsubscribeToken: "tok-1" },
      { userId: uid(2), unsubscribeToken: "tok-2" },
    ]);

    await asRole.enter();
    await setDigestInstance(db, uid(1), `${uid(1)}_2026-11-16`);

    expect(await getDigestInstances(db, [uid(1), uid(2)])).toEqual(
      new Map([[uid(1), `${uid(1)}_2026-11-16`]]),
    );
    expect(await getDigestInstances(db, [])).toEqual(new Map());
  });

  it("retrieval for a user with a home place reads the place tables", async () => {
    // The parity record's users have no home place, so its retrievals never touch these.
    const home = { placeId: 4509177, radiusMiles: 50 };

    await asRole.enter();

    await expect(
      retrieveCandidatesForProfile(db, tagged(oneHot(0)), {
        limit: 50,
        location: { mode: "any", home },
        recencyDays: 30,
      }),
    ).resolves.toEqual([]);
    await expect(countLocalStrings(db, home)).resolves.toBe(0);
  });

  it.each([
    ["read a session", `SELECT count(*) FROM session`],
    ["read an account's credentials", `SELECT count(*) FROM account`],
    ["read a CV file's key", `SELECT count(*) FROM user_cv_files`],
    ["change a user's email", `UPDATE "user" SET email = 'x@role.test'`],
    ["delete a job", `DELETE FROM jobs`],
    ["delete a user's preferences", `DELETE FROM user_preferences`],
    ["rewrite a profile", `UPDATE user_profiles SET structured = '{}'`],
  ])("cannot %s", async (_what, statement) => {
    await asRole.enter();
    await expect(pg.query(statement)).rejects.toThrow(/permission denied/);
  });
});
