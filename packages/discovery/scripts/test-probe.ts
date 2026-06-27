/**
 * Unit tests for the non-throwing probe layer: `probeFetch` (status/body
 * extraction + transient retry, never throws) and `probeCandidate` (jobsRequest build + classify via
 * the real adapters). `globalThis.fetch` is stubbed, so there is no network. Run with
 * `pnpm --filter @opusfinder/discovery test:probe`. node:assert/strict gives a non-zero exit on
 * failure (same idiom as the sources/eval test scripts).
 */
import assert from "node:assert/strict";

import { companySlug } from "@opusfinder/shared";
import type { SourceName } from "@opusfinder/shared";

import { probeCandidate, probeCandidates, probeFetch } from "../src/probe";
import type { Candidate } from "../src/types";

let handler: (url: string) => Response = () => {
  throw new Error("no handler set");
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request) => handler(String(url))) as typeof fetch;

function fakeResponse(status: number, bodyText: string, retryAfter?: string): Response {
  return {
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null),
    },
    text: () => Promise.resolve(bodyText),
    body: { cancel: () => Promise.resolve() },
  } as unknown as Response;
}

const req = (url: string) => ({ url });

const candidate = (source: SourceName, slug: string, host: string): Candidate => ({
  source,
  slug: companySlug(slug),
  rawSlug: slug,
  sourceUrl: `https://${host}/${slug}`,
});

async function main(): Promise<void> {
  handler = () => fakeResponse(200, JSON.stringify({ jobs: [{ id: 1 }] }));
  let probeResult = await probeFetch(req("https://x/y"));
  assert.equal(probeResult.status, 200);
  assert.deepEqual(probeResult.body, { jobs: [{ id: 1 }] });

  handler = () => fakeResponse(404, "Not Found");
  probeResult = await probeFetch(req("https://x/y"));
  assert.equal(probeResult.status, 404);
  assert.equal(probeResult.body, undefined);

  // probeFetch: a non-JSON body is not retried.
  handler = () => fakeResponse(200, "<html>nope</html>");
  probeResult = await probeFetch(req("https://x/y"));
  assert.equal(probeResult.status, 200);
  assert.equal(probeResult.body, undefined);

  // probeFetch: transient 503 then 200 → retried, returns 200 (exercises the backoff path).
  let calls = 0;
  handler = () =>
    calls++ === 0 ? fakeResponse(503, "busy") : fakeResponse(200, JSON.stringify({ ok: true }));
  probeResult = await probeFetch(req("https://x/y"), 3);
  assert.equal(probeResult.status, 200, "retried past 503");
  assert.equal(calls, 2, "fetch called twice");

  // probeFetch: network error, retries exhausted (maxRetries 0 → instant) → status 0.
  handler = () => {
    throw new Error("ECONNRESET");
  };
  probeResult = await probeFetch(req("https://x/y"), 0);
  assert.equal(probeResult.status, 0, "network-exhausted → status 0");

  // probeCandidate via the REAL greenhouse adapter (default classifier path).
  const greenhouseCandidate = candidate("greenhouse", "acme", "boards.greenhouse.io");
  handler = () => fakeResponse(200, JSON.stringify({ jobs: [{ id: 1, title: "x" }] }));
  assert.equal((await probeCandidate(greenhouseCandidate)).outcome, "live", "gh non-empty → live");
  handler = () => fakeResponse(200, JSON.stringify({ jobs: [] }));
  assert.equal((await probeCandidate(greenhouseCandidate)).outcome, "live-empty", "gh empty → live-empty");
  handler = () => fakeResponse(404, "not found");
  assert.equal((await probeCandidate(greenhouseCandidate)).outcome, "absent", "gh 404 → absent");

  // probeCandidate via SmartRecruiters classifyProbe (200 + totalFound:0 is unassertable).
  const smartRecruitersCandidate = candidate("smartrecruiters", "Ghost", "jobs.smartrecruiters.com");
  handler = () => fakeResponse(200, JSON.stringify({ content: [], totalFound: 0 }));
  assert.equal(
    (await probeCandidate(smartRecruitersCandidate)).outcome,
    "indeterminate",
    "SR empty → indeterminate",
  );
  handler = () => fakeResponse(200, JSON.stringify({ content: [{}], totalFound: 1 }));
  assert.equal((await probeCandidate(smartRecruitersCandidate)).outcome, "live", "SR found → live");

  // probeCandidates: probes every candidate, preserves INPUT ORDER (results[i] ↔ candidates[i]).
  // hostMinIntervalMs: 0 so the three same-host probes don't serialize on the 400 ms gate.
  const batch = [
    candidate("greenhouse", "alpha", "boards.greenhouse.io"),
    candidate("greenhouse", "bravo", "boards.greenhouse.io"),
    candidate("greenhouse", "charlie", "boards.greenhouse.io"),
  ];
  handler = (url) =>
    url.includes("/bravo/")
      ? fakeResponse(404, "gone")
      : fakeResponse(200, JSON.stringify({ jobs: [{ id: 1, title: "x" }] }));
  const results = await probeCandidates(batch, { hostMinIntervalMs: 0 });
  assert.equal(results.length, 3, "all candidates probed");
  assert.deepEqual(
    results.map((r) => r.candidate.rawSlug),
    ["alpha", "bravo", "charlie"],
    "results preserve input order",
  );
  assert.deepEqual(
    results.map((r) => r.outcome),
    ["live", "absent", "live"],
    "per-candidate outcomes routed correctly",
  );

  globalThis.fetch = realFetch;
  console.log("probe: all assertions passed.");
}

await main();
