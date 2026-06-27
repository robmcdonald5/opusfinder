import { cleanHtml } from "@opusfinder/sources";

import { resolveUrl } from "../resolve";
import type { CompanyRecord } from "../seed";

/**
 * The HN "Who is Hiring" seed lane. Hacker News' monthly "Ask HN: Who is hiring?" thread is the highest
 * yield-per-effort free source of covered ATS board URLs (Greenhouse/Lever/Ashby/… apply links pasted in
 * hiring comments). This lane makes TWO fetch-only Algolia JSON calls — one to find the latest thread, one
 * to pull its comment tree — then a regex/string pass extracts the covered board URLs. No HTML/DOM parser,
 * no Node builtins, so it stays Worker-safe (workerSafe:true) and bundle-clean. It is an ISOLATED lane
 * (SeedLane.failLoud omitted): an Algolia hiccup is tallied as lane_hn_error and skipped, never zeroing a
 * run.
 */

const HN_ALGOLIA = "https://hn.algolia.com/api/v1";
/** Per-fetch timeout (ms) — bounds the lane's contribution to the unattended weekly Worker discovery tick. */
const HN_FETCH_TIMEOUT_MS = 10_000;

/** One HN Algolia item node — only the fields this lane reads (the response carries far more). */
export interface HnItem {
  text?: string | null;
  children?: HnItem[] | null;
}

/**
 * Fetch + parse JSON, THROWING (with the body cancelled) on a non-2xx. resolveLanes wraps the lane in a
 * try/catch and, because hn is not failLoud, tallies lane_hn_error + continues — so a throw here is
 * isolated, never fatal. Cancelling the unconsumed body avoids the undici teardown footgun on Node.
 */
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(HN_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HN Algolia ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * The newest "Ask HN: Who is hiring?" story id. The `whoishiring` account also posts "Who wants to be
 * hired?" and "Freelancer?" threads, so the title is filtered. search_by_date returns newest-first, so
 * the first title match is the current month's thread. Returns null when none is found (no supply, not
 * an error).
 */
async function latestWhoIsHiringId(): Promise<string | null> {
  const data = await fetchJson<{ hits?: { objectID?: string; title?: string }[] }>(
    `${HN_ALGOLIA}/search_by_date?tags=story,author_whoishiring&hitsPerPage=30`,
  );
  for (const hit of data.hits ?? []) {
    if (hit.objectID && hit.title && /ask hn: who is hiring/i.test(hit.title)) return hit.objectID;
  }
  return null;
}

/** Depth-first collect every comment's HTML text from the thread tree. */
function collectText(node: HnItem, out: string[]): void {
  if (typeof node.text === "string" && node.text.length > 0) out.push(node.text);
  for (const child of node.children ?? []) collectText(child, out);
}

// http(s) URLs in HN comment HTML — both href="…" values and plain-text links. Stops at whitespace,
// quotes, angle brackets, and the closing brackets that wrap a URL; trailing prose punctuation is
// stripped separately below. Runs AFTER entity-decoding, so `//` is a literal slash, not `&#x2F;`.
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;

/**
 * Extract the covered-ATS board URLs from one comment's HTML text. Entity-decodes FIRST via the shared,
 * hardened `cleanHtml` decoder (HN encodes `/` as `&#x2F;`, so without decoding the text has no literal
 * `//` and yields zero URLs; the shared decoder also guards lone surrogates / control chars / out-of-range
 * code points, falling back to the raw entity instead of gluing a wrong slug). Then matches URLs, strips
 * trailing prose punctuation (incl. an author ellipsis), and keeps ONLY URLs an adapter's matchUrl claims
 * (resolveUrl) — homepages / GitHub / uncovered ATSes are dropped. DEDUPED by the resolved (source, rawSlug)
 * so HN's truncated display copy of a link (`…/c58c17` beside the full `…/c58c1714c2f0`) collapses onto the
 * full href (kept first) WITHOUT discarding a real board URL that merely ends in "...". A clipped
 * path-slug that resolves to a different slug stays distinct → a harmless absent probe.
 */
function atsUrlsFromComment(text: string): string[] {
  const byKey = new Map<string, string>(); // resolved "source:rawSlug" -> the first (full-href) URL
  for (const raw of cleanHtml(text, ["decode"]).match(URL_RE) ?? []) {
    const cleaned = raw.replace(/[.,;:!?…]+$/, "");
    let url: URL;
    try {
      url = new URL(cleaned);
    } catch {
      continue;
    }
    const hit = resolveUrl(url);
    if (hit === null) continue;
    const key = `${hit.source}:${hit.rawSlug}`;
    if (!byKey.has(key)) byKey.set(key, cleaned); // first occurrence wins = the full href (precedes its display copy)
  }
  return [...byKey.values()];
}

/**
 * Pure parse of a fetched HN thread tree → CompanyRecord[] (one record per hiring comment that carries
 * ≥1 covered board URL). Split out from the fetch so it is unit-testable from a captured payload with no
 * network (scripts/test-lane-hn.ts).
 */
export function parseHnThread(thread: HnItem): CompanyRecord[] {
  const texts: string[] = [];
  collectText(thread, texts);
  const records: CompanyRecord[] = [];
  for (const text of texts) {
    const ats_links = atsUrlsFromComment(text);
    if (ats_links.length > 0) records.push({ ats_links });
  }
  return records;
}

/** The registered lane fetch: find the latest thread, pull its tree, parse out covered board URLs. */
export async function fetchHnAlgoliaLane(): Promise<CompanyRecord[]> {
  const id = await latestWhoIsHiringId();
  if (id === null) return [];
  const thread = await fetchJson<HnItem>(`${HN_ALGOLIA}/items/${id}`);
  return parseHnThread(thread);
}
