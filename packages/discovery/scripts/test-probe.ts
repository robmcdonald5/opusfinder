/**
 * Unit tests for the non-throwing probe layer (Phase 7, sub-phase iv): `probeFetch` (status/body
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

// --- fetch stub -----------------------------------------------------------------------------
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
  // probeFetch: 200 with a JSON body → parsed body returned.
  handler = () => fakeResponse(200, JSON.stringify({ jobs: [{ id: 1 }] }));
  let r = await probeFetch(req("https://x/y"));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { jobs: [{ id: 1 }] });

  // probeFetch: 404 with a text body → status 404, body undefined, NO throw.
  handler = () => fakeResponse(404, "Not Found");
  r = await probeFetch(req("https://x/y"));
  assert.equal(r.status, 404);
  assert.equal(r.body, undefined);

  // probeFetch: 200 with a non-JSON body → status 200, body undefined, no retry, NO throw.
  handler = () => fakeResponse(200, "<html>nope</html>");
  r = await probeFetch(req("https://x/y"));
  assert.equal(r.status, 200);
  assert.equal(r.body, undefined);

  // probeFetch: transient 503 then 200 → retried, returns 200 (exercises the backoff path).
  let calls = 0;
  handler = () =>
    calls++ === 0 ? fakeResponse(503, "busy") : fakeResponse(200, JSON.stringify({ ok: true }));
  r = await probeFetch(req("https://x/y"), 3);
  assert.equal(r.status, 200, "retried past 503");
  assert.equal(calls, 2, "fetch called twice");

  // probeFetch: network error, retries exhausted (maxRetries 0 → instant) → status 0.
  handler = () => {
    throw new Error("ECONNRESET");
  };
  r = await probeFetch(req("https://x/y"), 0);
  assert.equal(r.status, 0, "network-exhausted → status 0");

  // probeCandidate via the REAL greenhouse adapter (default classifier path).
  const gh = candidate("greenhouse", "acme", "boards.greenhouse.io");
  handler = () => fakeResponse(200, JSON.stringify({ jobs: [{ id: 1, title: "x" }] }));
  assert.equal((await probeCandidate(gh)).outcome, "live", "gh non-empty → live");
  handler = () => fakeResponse(200, JSON.stringify({ jobs: [] }));
  assert.equal((await probeCandidate(gh)).outcome, "live-empty", "gh empty → live-empty");
  handler = () => fakeResponse(404, "not found");
  assert.equal((await probeCandidate(gh)).outcome, "absent", "gh 404 → absent");

  // probeCandidate via SmartRecruiters classifyProbe (200 + totalFound:0 is unassertable).
  const sr = candidate("smartrecruiters", "Ghost", "jobs.smartrecruiters.com");
  handler = () => fakeResponse(200, JSON.stringify({ content: [], totalFound: 0 }));
  assert.equal((await probeCandidate(sr)).outcome, "indeterminate", "SR empty → indeterminate");
  handler = () => fakeResponse(200, JSON.stringify({ content: [{}], totalFound: 1 }));
  assert.equal((await probeCandidate(sr)).outcome, "live", "SR found → live");

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
  const out = await probeCandidates(batch, { hostMinIntervalMs: 0 });
  assert.equal(out.length, 3, "all candidates probed");
  assert.deepEqual(
    out.map((r) => r.candidate.rawSlug),
    ["alpha", "bravo", "charlie"],
    "results preserve input order",
  );
  assert.deepEqual(
    out.map((r) => r.outcome),
    ["live", "absent", "live"],
    "per-candidate outcomes routed correctly",
  );

  globalThis.fetch = realFetch;
  console.log("probe: all assertions passed.");
}

await main();
