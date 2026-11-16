/**
 * The step adapter's own rules: the retry policy every step runs under, the stages' waits in the engine's
 * units, and what a failed step hands the engine (the no-retry error, and a failed query without its
 * parameters).
 */
import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { NonRetriableError } from "@opusfinder/digest";

import { rejectionReasonOf } from "@test/rejection";

import { durationMs, STEP_CONFIG, workflowStepTools, type WorkflowStepLike } from "./steps";

class NonRetryableError extends Error {
  override name = "NonRetryableError";
}

/** A step that runs its callback once, as the engine does on a first attempt. */
function step(): WorkflowStepLike & {
  do: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
} {
  return {
    do: vi.fn((_name: string, _config: unknown, callback: () => Promise<unknown>) => callback()),
    sleep: vi.fn(async () => undefined),
  } as never;
}

const tools = (s: WorkflowStepLike) => workflowStepTools(s, (m) => new NonRetryableError(m));

describe("the retry policy", () => {
  it("is what the stages had on Inngest: 4 retries after the first attempt, 5 minutes an attempt", () => {
    expect(STEP_CONFIG).toEqual({
      retries: { limit: 4, delay: 15_000, backoff: "exponential" },
      timeout: 300_000,
    });
  });

  it("applies to every step, under the stage's own step id", async () => {
    const s = step();
    await expect(tools(s).run("rerank", async () => ({ scored: 3 }))).resolves.toEqual({
      scored: 3,
    });
    expect(s.do).toHaveBeenCalledWith("rerank", STEP_CONFIG, expect.any(Function));
  });
});

describe("waits", () => {
  it.each([
    ["30s", 30_000],
    ["2m", 120_000],
    ["10m", 600_000],
    ["1h", 3_600_000],
  ])("%s is %d ms", (duration, ms) => {
    expect(durationMs(duration)).toBe(ms);
  });

  it.each(["2 minutes", "", "5", "m", "1.5m", "-1s"])("refuses %j", (duration) => {
    expect(() => durationMs(duration)).toThrow("unreadable step duration");
  });

  it("sleeps under the stage's id for the stage's duration", async () => {
    const s = step();
    await tools(s).sleep("synthesis-wait-3", "2m");
    expect(s.sleep).toHaveBeenCalledWith("synthesis-wait-3", 120_000);
  });
});

describe("what a failed step hands the engine", () => {
  it("the stages' no-retry error becomes the engine's, with the same message, and its reason is logged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const thrown = await rejectionReasonOf(
      tools(step()).run("persist", async () => {
        throw new NonRetriableError("digest: no usable reason for any item");
      }),
    );
    expect(thrown).toBeInstanceOf(NonRetryableError);
    expect((thrown as Error).message).toBe("digest: no usable reason for any item");
    expect(logged).toHaveBeenCalledWith(
      "digest: step persist failed and is not retried: digest: no usable reason for any item",
    );
    logged.mockRestore();
  });

  it("any other error passes through unchanged, so the engine retries it", async () => {
    const original = new Error("Resend send failed: application_error (500)");
    expect(
      await rejectionReasonOf(
        tools(step()).run("send-email", async () => {
          throw original;
        }),
      ),
    ).toBe(original);
  });

  it("a failed query is reduced to its Postgres reason and its SQL: no parameters, no connection string", async () => {
    const cause = Object.assign(
      new Error("connection to postgresql://digest_worker:s3cret@db.neon.tech/main refused"),
      { code: "08006" },
    );
    const failed = new DrizzleQueryError(
      'select "email" from "user" where "id" = $1',
      ["someone@example.com"],
      cause,
    );

    const thrown = (await rejectionReasonOf(
      tools(step()).run("load-v2", async () => {
        throw failed;
      }),
    )) as Error;

    // The engine keeps a step error's name and message (not its cause) in the instance's stored state.
    expect(thrown.name).toBe("Error");
    expect(thrown.message).toBe(
      '[code=08006] connection to postgresql://[redacted] refused | Failed query: select "email" from "user" where "id" = $1',
    );
    expect(thrown.message).not.toContain("someone@example.com");
    expect(thrown.message).not.toContain("s3cret");
    expect(thrown.cause).toBeUndefined();
  });

  it("a failed query with no cause still doesn't read as a raw drizzle message downstream", async () => {
    const failed = new DrizzleQueryError("select 1", ["p"]);
    const thrown = (await rejectionReasonOf(
      tools(step()).run("load-v2", async () => {
        throw failed;
      }),
    )) as Error;
    expect(thrown.message).toBe("query failed | Failed query: select 1");
  });
});
