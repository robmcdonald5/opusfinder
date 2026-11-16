/**
 * The fan-out's rules against a stand-in engine with PRODUCTION's semantics (a used id is refused; a
 * missing instance throws): one run per user per tick, never a second run while one is unfinished, a
 * failed run retried by the next tick, the per-tick limit, and one user's failure not stopping the rest.
 * engine.integration.test.ts runs the same code on the local Workflows engine.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRequestedEvent } from "@opusfinder/digest";

import {
  orchestratorRunId,
  startUserRuns,
  tickDate,
  userRunId,
  waitingSince,
  type FanOutStore,
  type UserRunBinding,
} from "./fan-out";

const ALICE = "00000000-0000-4000-8000-000000000001";
const BOB = "00000000-0000-4000-8000-000000000002";
const CAROL = "00000000-0000-4000-8000-000000000003";
const MON = "2026-11-16";
const TUE = "2026-11-17";
const WED = "2026-11-18";

const due = (...userIds: string[]): UserRequestedEvent[] =>
  userIds.map((userId) => ({ name: "digest/user.requested", data: { userId, digestRunId: 7 } }));

/** An engine that refuses a used id, as production does, and knows each instance's status. */
function engine() {
  const instances = new Map<string, string>();
  const binding: UserRunBinding = {
    create: vi.fn(async ({ id }) => {
      if (instances.has(id)) throw new Error("instance.already_exists");
      instances.set(id, "running");
    }),
    get: vi.fn(async (id) => {
      const status = instances.get(id);
      if (status === undefined) throw new Error("instance.not_found");
      return { status: async () => ({ status }) };
    }),
  };
  return { instances, binding };
}

/** The store: each user's last instance id, and since when they have been due (default: all equally,
 *  long ago, so the sweep's order decides). */
function memoryStore() {
  const ids = new Map<string, string>();
  const dueSince = new Map<string, number>();
  const store: FanOutStore = {
    state: async (userIds) =>
      new Map(
        userIds.map((u) => [u, { instanceId: ids.get(u) ?? null, dueSince: dueSince.get(u) ?? 0 }]),
      ),
    record: async (userId, instanceId) => void ids.set(userId, instanceId),
  };
  return { ids, dueSince, store };
}

/** Noon UTC on a tick's date, in epoch ms. */
const noon = (tick: string) => Date.parse(`${tick}T12:00:00Z`);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("run ids", () => {
  it("a tick is its scheduled time's UTC date", () => {
    expect(tickDate(Date.UTC(2026, 10, 16, 12, 10))).toBe(MON);
    expect(tickDate(Date.UTC(2026, 10, 16, 23, 59, 59))).toBe(MON);
  });

  it("fit Workflows' instance-id rule: at most 100 of [a-zA-Z0-9_-], not starting with a hyphen", () => {
    for (const id of [userRunId(ALICE, MON), orchestratorRunId(MON)]) {
      expect(id).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/);
      expect(id.length).toBeLessThanOrEqual(100);
    }
    expect(userRunId(ALICE, MON)).toBe(`${ALICE}_${MON}`);
  });
});

describe("startUserRuns", () => {
  it("starts one run per due user, under the user-and-tick id, with the user's event as params", async () => {
    const { binding } = engine();
    const { ids, store } = memoryStore();

    const result = await startUserRuns(store, binding, due(ALICE, BOB), MON, 10);

    expect(result).toEqual({ started: 2, inFlight: 0, alreadyStarted: 0, overLimit: 0 });
    expect(binding.create).toHaveBeenCalledWith({
      id: `${ALICE}_${MON}`,
      params: { userId: ALICE, digestRunId: 7 },
    });
    expect(ids.get(BOB)).toBe(`${BOB}_${MON}`);
  });

  it("a second start for the same user and tick starts nothing", async () => {
    const { instances, binding } = engine();
    const { store } = memoryStore();
    await startUserRuns(store, binding, due(ALICE), MON, 10);

    // A double cron fire, a retried fan-out step, or a second orchestrator: the same user, the same tick.
    const again = await startUserRuns(store, binding, due(ALICE), MON, 10);

    expect(again).toEqual({ started: 0, inFlight: 0, alreadyStarted: 1, overLimit: 0 });
    expect(binding.create).toHaveBeenCalledTimes(1);
    expect([...instances.keys()]).toEqual([`${ALICE}_${MON}`]);
    // And the engine itself refuses the id, whatever the caller checked first.
    await expect(
      binding.create({ id: userRunId(ALICE, MON), params: { userId: ALICE, digestRunId: 7 } }),
    ).rejects.toThrow("instance.already_exists");
  });

  it("skips a user whose earlier run is unfinished, for as many ticks as it runs", async () => {
    const { instances, binding } = engine();
    const { store } = memoryStore();
    await startUserRuns(store, binding, due(ALICE), MON, 10);

    // Monday's run is still in its batch wait on Tuesday and on Wednesday (production reports a
    // sleeping instance as `waiting`).
    instances.set(`${ALICE}_${MON}`, "waiting");
    expect(await startUserRuns(store, binding, due(ALICE), TUE, 10)).toMatchObject({
      started: 0,
      inFlight: 1,
    });
    expect(await startUserRuns(store, binding, due(ALICE), WED, 10)).toMatchObject({
      started: 0,
      inFlight: 1,
    });
    expect([...instances.keys()]).toEqual([`${ALICE}_${MON}`]);

    // It ends without stamping the user (say, it failed): the next tick starts a fresh run.
    instances.set(`${ALICE}_${MON}`, "errored");
    expect(await startUserRuns(store, binding, due(ALICE), "2026-11-19", 10)).toMatchObject({
      started: 1,
      inFlight: 0,
    });
  });

  it.each(["queued", "running", "paused", "waiting", "waitingForPause", "unknown"])(
    "counts a previous run that is %s as unfinished",
    async (status) => {
      const { instances, binding } = engine();
      const { store } = memoryStore();
      await startUserRuns(store, binding, due(ALICE), MON, 10);
      instances.set(`${ALICE}_${MON}`, status);

      expect(await startUserRuns(store, binding, due(ALICE), TUE, 10)).toMatchObject({
        started: 0,
        inFlight: 1,
      });
    },
  );

  it.each(["complete", "errored", "terminated"])(
    "starts the next run once the previous one is %s",
    async (status) => {
      const { instances, binding } = engine();
      const { store } = memoryStore();
      await startUserRuns(store, binding, due(ALICE), MON, 10);
      instances.set(`${ALICE}_${MON}`, status);

      expect(await startUserRuns(store, binding, due(ALICE), TUE, 10)).toMatchObject({
        started: 1,
      });
    },
  );

  it("starts a run when the recorded instance is gone (past its retention, or its start had failed)", async () => {
    const { binding } = engine();
    const { ids, store } = memoryStore();
    ids.set(ALICE, `${ALICE}_2026-10-01`);

    expect(await startUserRuns(store, binding, due(ALICE), MON, 10)).toMatchObject({ started: 1 });
  });

  it("records the instance before starting it, so a started run is never unrecorded", async () => {
    const { binding } = engine();
    const { ids, store } = memoryStore();
    vi.mocked(binding.create).mockImplementationOnce(async ({ id }) => {
      expect(ids.get(ALICE)).toBe(id);
      throw new Error("engine unavailable");
    });

    await expect(startUserRuns(store, binding, due(ALICE), MON, 10)).rejects.toThrow(
      "1 of 1 user run(s) not started: Error: engine unavailable",
    );
    // The id names no instance, which reads as nothing running: the retry starts it.
    expect(await startUserRuns(store, binding, due(ALICE), MON, 10)).toMatchObject({ started: 1 });
  });

  it("does not guess when a status read fails for another reason: the user is not started", async () => {
    const { binding } = engine();
    const { ids, store } = memoryStore();
    ids.set(ALICE, `${ALICE}_${MON}`);
    vi.mocked(binding.get).mockRejectedValueOnce(new Error("internal error"));

    await expect(startUserRuns(store, binding, due(ALICE), TUE, 10)).rejects.toThrow(
      "not started: Error: internal error",
    );
    expect(binding.create).not.toHaveBeenCalled();
  });

  it("one user's failure doesn't stop the others, and the retry starts only the one that failed", async () => {
    const { binding } = engine();
    const { store } = memoryStore();
    vi.mocked(binding.create).mockImplementationOnce(async () => {
      throw new Error("engine unavailable\nwith a second line");
    });

    await expect(startUserRuns(store, binding, due(ALICE, BOB, CAROL), MON, 10)).rejects.toThrow(
      /^1 of 3 user run\(s\) not started: Error: engine unavailable$/,
    );
    expect(await startUserRuns(store, binding, due(ALICE, BOB, CAROL), MON, 10)).toEqual({
      started: 1,
      inFlight: 0,
      alreadyStarted: 2,
      overLimit: 0,
    });
  });

  it("starts at most the tick's limit; the rest stay due, and a retry doesn't start more", async () => {
    const { binding } = engine();
    const { store } = memoryStore();

    expect(await startUserRuns(store, binding, due(ALICE, BOB, CAROL), MON, 2)).toEqual({
      started: 2,
      inFlight: 0,
      alreadyStarted: 0,
      overLimit: 1,
    });
    expect(await startUserRuns(store, binding, due(ALICE, BOB, CAROL), MON, 2)).toEqual({
      started: 0,
      inFlight: 0,
      alreadyStarted: 2,
      overLimit: 1,
    });
    // The next tick takes the user who was left (the first two were stamped, so they aren't due).
    expect(await startUserRuns(store, binding, due(CAROL), TUE, 2)).toMatchObject({ started: 1 });
  });

  it("the limit starves nobody: users whose runs fail every day don't keep the others out", async () => {
    const { instances, binding } = engine();
    const { store } = memoryStore();
    const startedOn = async (tick: string) => {
      const before = new Set(instances.keys());
      const result = await startUserRuns(store, binding, due(ALICE, BOB, CAROL), tick, 1);
      expect(result).toMatchObject({ started: 1, overLimit: 2 });
      const [id] = [...instances.keys()].filter((key) => !before.has(key));
      // The run fails without stamping its user, so all three are due again at the next tick.
      instances.set(id!, "errored");
      return id!.slice(0, ALICE.length);
    };

    // One slot a tick, every user due on every tick: each gets a turn before anyone gets a second.
    expect(await startedOn(MON)).toBe(ALICE);
    expect(await startedOn(TUE)).toBe(BOB);
    expect(await startedOn(WED)).toBe(CAROL);
    expect(await startedOn("2026-11-19")).toBe(ALICE);
    expect(await startedOn("2026-11-20")).toBe(BOB);
  });

  it("the limit starves nobody: a steady inflow of new users doesn't keep an existing user out", async () => {
    const { instances, binding } = engine();
    const { ids, dueSince, store } = memoryStore();
    // Two existing users, due since before the first tick. Each had a digest long ago, so each has an
    // old instance on record (finished; gone from the engine).
    ids.set(ALICE, `${ALICE}_2026-11-02`);
    ids.set(BOB, `${BOB}_2026-11-03`);
    dueSince.set(ALICE, noon("2026-11-14"));
    dueSince.set(BOB, noon("2026-11-15"));
    const ticks = [MON, TUE, WED, "2026-11-19", "2026-11-20"];
    const started: string[] = [];
    const waitingNewcomers: string[] = [];

    for (const [i, tick] of ticks.entries()) {
      // Every tick as many brand-new users become due as the limit lets start (one), each never run.
      const newcomer = `newcomer-${i}`;
      dueSince.set(newcomer, noon(tick) - 3_600_000);
      waitingNewcomers.push(newcomer);
      const dueNow = [...waitingNewcomers, ALICE, BOB].filter((user) => !started.includes(user));
      const before = new Set(instances.keys());

      await startUserRuns(store, binding, due(...dueNow), tick, 1);

      const [id] = [...instances.keys()].filter((key) => !before.has(key));
      instances.set(id!, "complete"); // it finishes and stamps its user, who isn't due again this week
      started.push(id!.slice(0, -`_${tick}`.length));
    }

    // First come, first served: the two who were already waiting, then the newcomers in arrival order.
    expect(started).toEqual([ALICE, BOB, "newcomer-0", "newcomer-1", "newcomer-2"]);
  });

  it("orders by how long a user has waited: due first, then since their last run was started", () => {
    const due = noon("2026-11-10");
    // Never run: waiting since they became due.
    expect(waitingSince({ instanceId: null, dueSince: due })).toBe(due);
    // Last run long before they became due again (it finished and stamped them): still since due.
    expect(waitingSince({ instanceId: `${ALICE}_2026-11-03`, dueSince: due })).toBe(due);
    // Last run started after they became due (it failed): since the end of that run's day.
    expect(waitingSince({ instanceId: `${ALICE}_2026-11-12`, dueSince: due })).toBe(
      Date.parse("2026-11-12T23:59:59.999Z"),
    );
    // An id that doesn't end in a date, or a user the store doesn't know: never behind anyone for it.
    expect(waitingSince({ instanceId: "something-else", dueSince: due })).toBe(due);
    expect(waitingSince(undefined)).toBe(0);
  });

  it("a limit of 0 starts nothing", async () => {
    const { binding } = engine();
    const { store } = memoryStore();

    expect(await startUserRuns(store, binding, due(ALICE), MON, 0)).toMatchObject({
      started: 0,
      overLimit: 1,
    });
  });
});
