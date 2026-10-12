import { afterEach, describe, expect, it, vi } from "vitest";

import { runScript } from "./script";

describe("runScript", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("prints a failed query's cause, never drizzle's params line", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // drizzle's DrizzleQueryError shape, with the email the CLI looked up as a bound param.
    const err = new Error('Failed query: select "id" from "user" where "email" = $1\nparams: jane@x.com', {
      cause: Object.assign(new Error("project size limit exceeded"), { code: "53100" }),
    });

    await runScript("user-approve", () => {
      throw err;
    });

    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toMatch(/^user-approve failed: \[code=53100\] project size limit exceeded \| /);
    expect(line).not.toContain("jane@x.com");
    expect(process.exitCode).toBe(1);
  });
});
