import { runScript } from "@opusfinder/shared/script";

import { pingWatchdogFail } from "../src/index.ts";

/**
 * H1a smoke (NO network, NO creds) for the Worker failure ping. Stubs the global `fetch` + a fake
 * `ExecutionContext` to capture the call without leaving the process, and asserts the published-surface
 * contract from PHASE_H1_PLAN.md:
 *   - a NO-OP (no fetch, no ctx.waitUntil) when HEALTH_PING_URL is unset (redeploy-before-watchdog);
 *   - otherwise a fire-and-forget POST to `${HEALTH_PING_URL}/fail` carrying the message as the body;
 *   - the body is capped at 500 chars (the shape-safe cap on a surface that lands in healthchecks.io).
 * The actual DOWN-with-cause behaviour is the H1d live gate's job; this locks the wiring.
 *
 * Run from the repo root via tsx (apps/scrapers carries no test runner): `pnpm test:watchdog`.
 */
type FetchCall = { url: string; init?: RequestInit };

await runScript("test-watchdog-fail", async () => {
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as typeof fetch;

  const waited: Array<Promise<unknown>> = [];
  // A minimal ExecutionContext: only waitUntil is exercised (types are erased under tsx).
  const ctx = { waitUntil: (p: Promise<unknown>) => waited.push(p) } as unknown as ExecutionContext;
  const unsetEnv = {} as Env;
  const setEnv = { HEALTH_PING_URL: "https://watchdog.invalid/abc123" } as Env;

  try {
    // 1) Unset HEALTH_PING_URL ⇒ no-op (no fetch, no scheduled work).
    pingWatchdogFail(unsetEnv, ctx, "scheduled(0 * * * *) failed: boom");
    assert(calls.length === 0, "unset HEALTH_PING_URL must not fetch");
    assert(waited.length === 0, "unset HEALTH_PING_URL must not schedule waitUntil");

    // 2) Set URL ⇒ fire-and-forget POST to `${url}/fail` with the message body.
    pingWatchdogFail(setEnv, ctx, "scheduled(0 * * * *) failed: kaboom");
    assert(calls.length === 1, "set HEALTH_PING_URL must fetch exactly once");
    assert(
      calls[0].url === "https://watchdog.invalid/abc123/fail",
      `must POST to {url}/fail, got ${calls[0].url}`,
    );
    assert(calls[0].init?.method === "POST", "must use POST");
    assert(
      calls[0].init?.body === "scheduled(0 * * * *) failed: kaboom",
      "a short message rides through verbatim as the body",
    );
    assert(waited.length === 1, "the ping is fire-and-forget via ctx.waitUntil");

    // 3) A long message is capped at 500 chars (the shape-safe published-surface cap).
    pingWatchdogFail(setEnv, ctx, "x".repeat(5000));
    const longBody = calls[1].init?.body;
    assert(typeof longBody === "string", "body must be a string");
    assert((longBody as string).length === 500, `body must be capped at 500 chars, got ${(longBody as string).length}`);

    // 4) A MULTI-LINE message (the drizzle `DrizzleQueryError` shape) ships its FIRST LINE only — the
    //    `params:` array on line 2 must NOT reach the published surface (decision 3 / the SQL-leak guard).
    pingWatchdogFail(
      setEnv,
      ctx,
      "scheduled(0 * * * *) failed: DrizzleQueryError: Failed query: SELECT * FROM jobs\nparams: secret-value-42",
    );
    const multiBody = calls[2].init?.body as string;
    assert(typeof multiBody === "string" && !multiBody.includes("\n"), "body must be a single line");
    assert(!multiBody.includes("params:"), "the drizzle `params:` line must be dropped from the published body");
    assert(!multiBody.includes("secret-value-42"), "line-2 content must not leak to the published surface");
    assert(
      multiBody === "scheduled(0 * * * *) failed: DrizzleQueryError: Failed query: SELECT * FROM jobs",
      "body is the first line verbatim",
    );

    await Promise.all(waited); // drain the fire-and-forget promises before restoring fetch
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(
    "test-watchdog-fail OK — no-op when HEALTH_PING_URL unset; POST to {url}/fail with the message body; " +
      "500-char cap on a long message; a multi-line drizzle message ships its first line only (no `params:`).",
  );
});

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
