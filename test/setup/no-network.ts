import { afterEach } from "vitest";

/**
 * Network lock for the `unit` project (registered via setupFiles). Unit suites have no MSW, and any that
 * imports a package env module has that package's real `.env` loaded (loadPackageEnv), so a suite that
 * forgets to stub would send a real, credentialed vendor call. `fetch` and `WebSocket` are replaced by
 * plain assignment, NOT vi.stubGlobal: a suite's own vi.stubGlobal still wins, and its
 * vi.unstubAllGlobals() restores this lock rather than the real network. As in the integration setup, a
 * blocked attempt also fails the test in afterEach, because fail-soft code would swallow the rejection.
 */
const blocked: string[] = [];
const block = (what: string): Error => {
  blocked.push(what);
  return new Error(`${what} is blocked in unit tests: stub it, or test it under MSW (integration)`);
};
const noQuery = (url: unknown) => String(url instanceof Request ? url.url : url).split(/[?#]/)[0];

globalThis.fetch = async (input) => {
  throw block(`fetch ${noQuery(input)}`);
};
globalThis.WebSocket = class {
  constructor(url: string | URL) {
    throw block(`WebSocket ${noQuery(url)}`);
  }
} as unknown as typeof WebSocket;

afterEach(() => {
  if (blocked.length > 0) {
    throw new Error(`unstubbed network call(s): ${blocked.splice(0).join(", ")}`);
  }
});
