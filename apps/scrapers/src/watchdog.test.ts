import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pingWatchdogFail } from "./index";

// Leaf pure-unit (no network, no creds). Locks the published-surface contract of the Worker failure
// ping so a regression can't (a) start pinging before HEALTH_PING_URL is deployed, or (b) leak a
// multi-line drizzle `params:` tail / oversized stack to the watchdog body. Stubs global `fetch` + a
// fake ExecutionContext to capture the fire-and-forget call. Ports scripts/test-watchdog-fail.ts.

const PING_URL = "https://watchdog.invalid/abc123";

type FetchCall = { url: string; init?: RequestInit };

// A minimal ExecutionContext: only waitUntil is exercised (Worker types are erased under vitest/esbuild).
function makeCtx(waited: Array<Promise<unknown>>): ExecutionContext {
  return { waitUntil: (p: Promise<unknown>) => waited.push(p) } as unknown as ExecutionContext;
}

describe("pingWatchdogFail", () => {
  let calls: FetchCall[];
  let waited: Array<Promise<unknown>>;
  let ctx: ExecutionContext;
  const setEnv = { HEALTH_PING_URL: PING_URL } as unknown as Env;

  beforeEach(() => {
    calls = [];
    waited = [];
    ctx = makeCtx(waited);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return Promise.resolve(new Response(null, { status: 200 }));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a NO-OP when HEALTH_PING_URL is unset (redeploy-before-watchdog)", () => {
    pingWatchdogFail({} as Env, ctx, "scheduled(0 * * * *) failed: boom");

    expect(calls).toHaveLength(0);
    expect(waited).toHaveLength(0);
  });

  it("fires a fire-and-forget POST to {url}/fail via ctx.waitUntil", () => {
    pingWatchdogFail(setEnv, ctx, "scheduled(0 * * * *) failed: kaboom");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${PING_URL}/fail`);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(waited).toHaveLength(1); // scheduled, not blocking the tick
  });

  // The published body for a range of message shapes — the load-bearing shape-safety cases.
  it.each([
    {
      label: "a short message rides through verbatim",
      message: "scheduled(0 * * * *) failed: kaboom",
      expected: "scheduled(0 * * * *) failed: kaboom",
    },
    {
      label: "a long message is capped at 500 chars",
      message: "x".repeat(5000),
      expected: "x".repeat(500),
    },
    {
      label: "a multi-line drizzle message ships its FIRST LINE only (no `params:` / secret tail)",
      message:
        "scheduled(0 * * * *) failed: DrizzleQueryError: Failed query: SELECT * FROM jobs\nparams: secret-value-42",
      expected: "scheduled(0 * * * *) failed: DrizzleQueryError: Failed query: SELECT * FROM jobs",
    },
    {
      label: "an empty message yields an empty body",
      message: "",
      expected: "",
    },
    {
      label: "a leading newline yields an empty body (first line is empty)",
      message: "\nparams: secret-value-42",
      expected: "",
    },
  ])("body: $label", ({ message, expected }) => {
    pingWatchdogFail(setEnv, ctx, message);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.body).toBe(expected);
  });

  // The slice(0, 500) boundary: exactly 500 rides verbatim, 501 loses precisely its last char.
  it.each([
    { label: "exactly 500 chars rides verbatim", len: 500, expectedLen: 500 },
    { label: "501 chars is truncated to 500", len: 501, expectedLen: 500 },
  ])("cap boundary: $label", ({ len, expectedLen }) => {
    pingWatchdogFail(setEnv, ctx, "x".repeat(len));

    expect((calls[0]!.init?.body as string).length).toBe(expectedLen);
  });

  it("applies the 500-char cap to the FIRST LINE, dropping a secret second line entirely", () => {
    // First line > 500 AND a secret second line: the cap and the line-1 split must compose, so the
    // body is the capped first line with no part of line 2 surviving.
    pingWatchdogFail(setEnv, ctx, `${"a".repeat(600)}\nparams: secret-value-42`);

    const body = calls[0]!.init?.body as string;
    expect(body).toBe("a".repeat(500));
    expect(body).not.toContain("secret-value-42");
  });

  it("never leaks line-2 content of a multi-line message to the published surface", () => {
    pingWatchdogFail(
      setEnv,
      ctx,
      "scheduled(0 * * * *) failed: DrizzleQueryError\nparams: secret-value-42",
    );

    const body = calls[0]!.init?.body as string;
    expect(body).not.toContain("\n");
    expect(body).not.toContain("params:");
    expect(body).not.toContain("secret-value-42");
  });
});
