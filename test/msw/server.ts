import { setupServer } from "msw/node";

import { handlers } from "./handlers";

/**
 * The MSW server INSTANCE — construction ONLY, no lifecycle hooks. Split out from test/setup/msw.ts so
 * integration suites can `import { server } from "@test/msw/server"` and register per-test handlers with
 * `server.use(...)` (request capture, per-status scripting, stateful multi-hop responses). The setup
 * file (test/setup/msw.ts) imports this instance and owns the beforeAll/afterEach/afterAll hooks; it is
 * eslint-import-banned everywhere else because its top-level hooks must run ONLY as the integration
 * project's setupFile. This module has no hooks, so importing it anywhere is inert and safe.
 *
 * `afterEach(resetHandlers)` in the setup restores this base handler list, so suite-local `server.use`
 * overrides self-clean between tests.
 */
export const server = setupServer(...handlers);
