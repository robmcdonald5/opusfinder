import { describe, expect, it } from "vitest";

import { cadence } from "./cadence";
import { stages } from "./registry";

const at = (iso: string) => Date.parse(iso);

describe("cadence", () => {
  const every2h = stages.ingest.expect; // 120 min, 60 min grace

  it("puts the next run one period after the last start", () => {
    expect(
      cadence(every2h, "on", "2026-10-10T14:00:12.868Z", null, at("2026-10-10T15:00:00Z")),
    ).toEqual({
      nextDueAt: "2026-10-10T16:00:12.868Z",
      overdue: false,
    });
  });

  it("is overdue only once the period AND its grace have passed", () => {
    const last = "2026-10-10T14:00:00Z";
    expect(cadence(every2h, "on", last, null, at("2026-10-10T17:00:00Z")).overdue).toBe(false);
    expect(cadence(every2h, "on", last, null, at("2026-10-10T17:00:01Z")).overdue).toBe(true);
  });

  it("never calls an off stage late (a pause is not an outage)", () => {
    expect(
      cadence(every2h, "off", "2026-10-01T00:00:00Z", null, at("2026-10-10T00:00:00Z")),
    ).toEqual({
      nextDueAt: null,
      overdue: false,
    });
  });

  it("says nothing without a recorded run, an expected period or a readable time", () => {
    const now = at("2026-10-10T00:00:00Z");
    expect(cadence(every2h, "on", null, "2026-10-09T00:00:00Z", now)).toEqual({
      nextDueAt: null,
      overdue: false,
    });
    expect(cadence(undefined, "on", "2026-10-01T00:00:00Z", null, now)).toEqual({
      nextDueAt: null,
      overdue: false,
    });
    expect(cadence(every2h, "on", "not a time", null, now)).toEqual({
      nextDueAt: null,
      overdue: false,
    });
  });

  it("counts from a later resume, so resuming after a pause isn't a missed run", () => {
    // discover: weekly + 6 h grace. Off for three weeks, back on two days ago.
    const weekly = stages.discover.expect;
    const now = at("2026-10-30T00:00:00Z");
    const resumed = cadence(weekly, "on", "2026-10-04T03:00:00Z", "2026-10-28T00:00:00Z", now);
    expect(resumed).toEqual({ nextDueAt: "2026-11-04T00:00:00.000Z", overdue: false });
    // Without the resume it would read as weeks overdue.
    expect(cadence(weekly, "on", "2026-10-04T03:00:00Z", null, now).overdue).toBe(true);
    // An older resume doesn't move the baseline back.
    expect(
      cadence(
        every2h,
        "on",
        "2026-10-10T14:00:00Z",
        "2026-10-07T03:23:00Z",
        at("2026-10-10T15:00:00Z"),
      ).nextDueAt,
    ).toBe("2026-10-10T16:00:00.000Z");
  });

  it("treats a shadow stage like an on one (it runs)", () => {
    expect(
      cadence(
        stages.embed.expect,
        "shadow",
        "2026-10-01T04:00:00Z",
        null,
        at("2026-10-03T00:00:00Z"),
      ).overdue,
    ).toBe(true);
  });
});
