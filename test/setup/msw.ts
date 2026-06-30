import { afterAll, afterEach, beforeAll } from "vitest";
import { setupServer } from "msw/node";

import { handlers } from "../msw/handlers";

/**
 * One MSW server for the whole `integration` project (registered via setupFiles). Unmocked HTTP is a
 * HARD error so a test can never silently hit the real network in CI; the live `skipIf` gates that
 * intentionally reach real providers are the only network egress, and they run only when their creds
 * (and explicit opt-in flags) are present. `server.close()` in afterAll unpatches the http/fetch
 * interceptors so Windows teardown stays clean.
 */
export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
