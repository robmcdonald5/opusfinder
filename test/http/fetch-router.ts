// A PURE (no `vi`) fetch stand-in for the integration suites that drive the real orchestrators
// (runDiscovery, runIngestion). Those reach the network through the GLOBAL `fetch` with no DI seam, so a
// suite builds a `routedFetch`, installs it via `vi.stubGlobal("fetch", ...)` in beforeEach, and restores
// it via `vi.unstubAllGlobals()` in afterEach. The stub SHADOWS the integration MSW rig (test/setup/msw.ts,
// onUnhandledRequest:"error"): the request never reaches MSW's interceptor, so the hard-fail never fires
// and no real socket opens. Kept `vi`-free — the same convention as packages/discovery/test/http-stubs.ts's
// `fakeResponse` — so it is neither collected as a suite nor coupled to the runner; the suite owns the
// stub/unstub lifecycle. Real `Response` objects round-trip .ok/.status/.statusText/.text()/.json()/.body,
// so the fetch-consuming code (probeFetch's body-drain, runAdapter's JSON parse) is exercised faithfully.

export interface Route {
  /** Claim a request by its resolved URL string. The FIRST matching route wins. */
  match: (url: string) => boolean;
  /** Produce the Response, or THROW to simulate a network-layer failure (an ECONNRESET-style reject). */
  respond: (url: string) => Response | Promise<Response>;
}

export interface RoutedFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** Every request URL, in call order — asserts a probe fired / a board was skipped / a URL fetched once. */
  readonly calls: string[];
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function routedFetch(routes: Route[]): RoutedFetch {
  const calls: string[] = [];
  const fn = async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    calls.push(url);
    const route = routes.find((r) => r.match(url));
    if (!route) {
      // An unrouted URL is a TEST bug, not a modeled outcome — surface it loudly. (Inside
      // runAdapter/probeFetch this throw is treated as a transient network failure; with maxRetries:0
      // it degrades to an immediate visible board failure / status-0 probe carrying this message.)
      throw new Error(`routedFetch: no route for ${url}`);
    }
    return route.respond(url);
  };
  return Object.assign(fn, { calls }) as RoutedFetch;
}

/** A JSON Response (2xx by default) — the shape the ATS board APIs and the discovery seed lane return. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A text/other Response (non-JSON body, e.g. a 404 page or an HTML 429) at the given status. */
export function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}
