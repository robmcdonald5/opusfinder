/**
 * The one-off fetch behind the snapshot's US public-sector slice. Not an ingest adapter: it runs once,
 * for the eval, and nothing here writes to production.
 *
 *  - USAJOBS Search API (federal postings open to the public). Terms: "Public Data may be copied,
 *    stored, reformatted, adapted, analyzed, published, redistributed, and used for lawful commercial
 *    or noncommercial purposes" (developer.usajobs.gov/guides/terms-of-service). Needs the owner's
 *    registered key; the registered email goes in the User-Agent, as the API requires.
 *  - NYC Jobs, NYC Open Data dataset kpav-sd4t (city postings). Terms: "There are no restrictions on
 *    the use of Open Data"; source: NYC Department of Citywide Administrative Services. No key.
 *
 * Both hosts get at most one request a second.
 */
import "../env";

import { requireEnv } from "@opusfinder/shared/env";

const getUsajobsKey = requireEnv({
  name: "USAJOBS_API_KEY",
  notSetMessage:
    "USAJOBS_API_KEY is not set. Put the registered USAJOBS key in packages/eval/.env.",
});
const getUsajobsUserAgent = requireEnv({
  name: "USAJOBS_USER_AGENT",
  notSetMessage:
    "USAJOBS_USER_AGENT is not set. Put the email the USAJOBS key was registered with in packages/eval/.env.",
});

const USAJOBS_URL = "https://data.usajobs.gov/api/Search";
const USAJOBS_PAGE = 500;
/** The API returns at most this many results for one query; a total at the cap means some are cut off. */
const USAJOBS_QUERY_CAP = 10_000;
const NYC_URL = "https://data.cityofnewyork.us/resource/kpav-sd4t.json";
const NYC_PAGE = 5_000;
const REQUEST_GAP_MS = 1_100;

/** What each feed was asked for, word for word in the manifest. */
export const PUBLIC_SELECTION =
  "USAJOBS Search API, HiringPath=public (every posting open to the public), plus NYC Jobs " +
  "(NYC Open Data kpav-sd4t), posting_type = 'External' and not past post_until";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    const snippet = await res.text().catch(() => "");
    throw new Error(
      `${new URL(url).host} answered ${res.status} ${res.statusText}: ${snippet.slice(0, 200)}`,
    );
  }
  return res.json();
}

/** Every USAJOBS posting open to the public, as the API returns them (`SearchResultItems`). */
export async function fetchUsajobs(log: (line: string) => void = () => {}): Promise<unknown[]> {
  const headers = {
    Host: "data.usajobs.gov",
    "User-Agent": getUsajobsUserAgent(),
    "Authorization-Key": getUsajobsKey(),
  };
  const items: unknown[] = [];
  for (let page = 1; ; page++) {
    const body = (await getJson(
      `${USAJOBS_URL}?HiringPath=public&Fields=Full&ResultsPerPage=${USAJOBS_PAGE}&Page=${page}`,
      headers,
    )) as { SearchResult?: { SearchResultCountAll?: number; SearchResultItems?: unknown[] } };
    const total = body.SearchResult?.SearchResultCountAll;
    const pageItems = body.SearchResult?.SearchResultItems;
    if (typeof total !== "number" || !Array.isArray(pageItems)) {
      throw new Error("USAJOBS answered without SearchResult.SearchResultItems.");
    }
    if (total >= USAJOBS_QUERY_CAP) {
      throw new Error(
        `USAJOBS reports ${total} results, its per-query cap: the query no longer returns every ` +
          `posting and must be split before this slice can claim to be complete.`,
      );
    }
    items.push(...pageItems);
    log(`  usajobs: ${items.length} of ${total}`);
    if (pageItems.length === 0 || items.length >= total) return items;
    await sleep(REQUEST_GAP_MS);
  }
}

/** Every external NYC Jobs row (expired ones are dropped when the rows are read). */
export async function fetchNycJobs(log: (line: string) => void = () => {}): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let offset = 0; ; offset += NYC_PAGE) {
    const query = new URLSearchParams({
      $where: "posting_type = 'External'",
      $order: "job_id, posting_updated",
      $limit: String(NYC_PAGE),
      $offset: String(offset),
    });
    const page = await getJson(`${NYC_URL}?${query}`, {});
    if (!Array.isArray(page)) throw new Error("NYC Open Data answered without a row array.");
    rows.push(...page);
    log(`  nyc: ${rows.length}`);
    if (page.length < NYC_PAGE) return rows;
    await sleep(REQUEST_GAP_MS);
  }
}
