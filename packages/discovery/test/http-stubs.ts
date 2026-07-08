// Shared test HTTP stubs for the probe suites (probe-fetch + probe-candidates). It lives under
// `packages/discovery/test/` on purpose: Vitest only collects `*.test.ts` files under `src`, and the
// shippable package tsconfig compiles only `src` + `scripts`, so this helper is neither run as a suite
// nor shipped — it is type-checked transitively through the importing test files (tsconfig.test.json).

/**
 * A minimal `Response` stand-in shaped to exactly what `probeFetch` reads: `status`, a case-insensitive
 * `headers.get` that only knows `retry-after`, a `text()` body, and a cancellable `body` (probeFetch
 * calls `res.body?.cancel()` on a non-2xx / pre-retry response). One source of truth so a change to the
 * stubbed contract can't silently diverge between the two probe suites.
 */
export function fakeResponse(status: number, bodyText: string, retryAfter?: string): Response {
  return {
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null),
    },
    text: () => Promise.resolve(bodyText),
    body: { cancel: () => Promise.resolve() },
  } as unknown as Response;
}
