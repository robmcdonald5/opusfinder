import { afterAll, afterEach, beforeAll } from "vitest";
import { setupServer } from "msw/node";

import { handlers } from "../msw/handlers";

/**
 * One MSW server for the whole `integration` project (registered via setupFiles). Unmocked HTTP is a
 * HARD error (`onUnhandledRequest: "error"`), so a suite in this project can NEVER hit the real
 * network — an unhandled request fails the test loudly. In MSW 2.x this also covers WebSockets:
 * `setupServer` patches `globalThis.WebSocket`, so an unmocked WS connection (e.g. neon-serverless)
 * fails under `"error"` too — it is NOT silently allowed through. This project therefore permits
 * ZERO live egress by design.
 *
 * Real-network live gates do NOT belong here. They live in the separate `live` vitest project
 * (`*.live.test.ts`, no MSW server), each `skipIf`-gated on an explicit opt-in flag + its creds.
 *
 * `server.close()` in afterAll unpatches the http/fetch/WebSocket interceptors so Windows teardown
 * stays clean.
 */
export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
