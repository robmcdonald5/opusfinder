import { afterAll, afterEach, beforeAll } from "vitest";

import { server } from "../msw/server";

/**
 * MSW lifecycle for the whole `integration` project (registered via setupFiles). Unmocked HTTP is a
 * HARD error (`onUnhandledRequest: "error"`), so a suite in this project can NEVER hit the real
 * network. In MSW 2.x this also covers WebSockets: `setupServer` patches `globalThis.WebSocket`, so an
 * unmocked WS connection (e.g. neon-serverless) fails under `"error"` too — it is NOT silently allowed
 * through. This project therefore permits ZERO live egress by design.
 *
 * `"error"` only rejects the intercepted fetch, though, and fail-soft code (a probe that maps any throw
 * to 'error') would turn a missing or mistyped handler into its normal outcome and pass. So every
 * unhandled HTTP request is also recorded and fails the test in afterEach. Keep the STRING preset: a
 * callback's `print.error()` only logs and lets the request through to the real network.
 *
 * The server INSTANCE lives in ../msw/server (construction only, no hooks) so integration suites can
 * `import { server } from "@test/msw/server"` and call `server.use(...)`; THIS file owns the lifecycle
 * hooks and must run ONLY as the integration project's setupFile (hence the eslint ban on importing it).
 *
 * Real-network live gates do NOT belong here. They live in the separate `live` vitest project
 * (`*.live.test.ts`, no MSW server), each `skipIf`-gated on an explicit opt-in flag + its creds.
 *
 * `server.close()` in afterAll unpatches the http/fetch/WebSocket interceptors so Windows teardown
 * stays clean.
 */
const unhandled: string[] = [];
server.events.on("request:unhandled", ({ request }) => {
  const url = new URL(request.url);
  unhandled.push(`${request.method} ${url.origin}${url.pathname}`); // no query string: it can carry keys
});

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  if (unhandled.length > 0) {
    throw new Error(`unhandled request(s), add an MSW handler: ${unhandled.splice(0).join(", ")}`);
  }
});
afterAll(() => server.close());
