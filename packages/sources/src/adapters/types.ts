import type { CompanySlug, NormalizedJob, SourceName } from "@opusfinder/shared";

/**
 * A discovery probe's outcome (Phase 7). `live` + `live-empty` both PROVE the slug exists (an
 * empty live board is healthy — only `absent` counts as a failed probe for staleness). `absent`
 * = the slug is confirmed NOT to exist. `indeterminate` = existence can't be asserted (e.g.
 * SmartRecruiters' ambiguous `200 + totalFound:0`, OR a 2xx whose body fails `locate`, OR a
 * network-exhausted probe) → the caller skips the DB write and never deactivates on it.
 */
export type ProbeOutcome = "live" | "live-empty" | "absent" | "indeterminate";

/**
 * The per-source adapter contract — EXTRACTED (Phase 6) from the concrete Greenhouse,
 * Lever, and SmartRecruiters adapters, not designed up front. A thin `runAdapter`
 * (see ./run-adapter) owns the invariant plumbing — fetch, retry/backoff, the
 * pagination loop, per-item resilience, the hydrate pool — and each `SourceAdapter`
 * supplies ONLY what differs across platforms. `mapItem` stays a typed function per
 * source (never declarative config).
 */
export interface SourceAdapter {
  /** Literal tag written onto every NormalizedJob.source AND the registry key. */
  readonly source: SourceName;

  /**
   * ATS-specific slug canonicalization, run ONCE before branding. Greenhouse/Workable
   * lowercase; Lever/Ashby/SmartRecruiters preserve case (their IDs are case-sensitive,
   * or apply URLs echo the casing). MUST end in `companySlug(...)` so the universal floor
   * applies. Reused by Phase 7 discovery so a stored slug matches what ingestion requests.
   */
  normalizeSlug(rawSlug: string): CompanySlug;

  /**
   * Phase 7 discovery: the INVERSE of `jobsRequest`. Decide whether `url` is one of THIS source's
   * board/API URLs and, if so, return the RAW (pre-`normalizeSlug`) slug; else `null`. The caller
   * runs `normalizeSlug(raw)` to canonicalize, so casing/floor rules stay in ONE place. REQUIRED
   * so a forgotten rule on a future adapter is a COMPILE error at the `Record<SourceName,...>`
   * registry. MUST NOT throw on a foreign/odd URL — return `null`. Parse from the BOARD/API host
   * ONLY, never an apply URL (custom/vanity apply domains exist, and Gem's apply URL is
   * Greenhouse-shaped). Reuses this file's existing host constant — no endpoint pattern is
   * re-encoded in `packages/discovery`.
   */
  matchUrl(url: URL): string | null;

  /**
   * Phase 7 discovery: interpret a probe response for THIS source — a sibling of `locate` (both
   * read the same raw envelope) but TOTAL where `locate` is partial: it must read a 404/400/error
   * body WITHOUT throwing, because the prober does not throw on `!ok`. `status` is the HTTP status
   * (0 ⇒ network-exhausted); `body` is the parsed JSON, or `undefined` for a non-JSON/unparsed
   * body. OMIT ⇒ discovery's default classifier (status-first: 404 ⇒ `absent` without calling
   * `locate`; 2xx ⇒ `locate(body).length > 0 ? live : live-empty`, a `locate` throw ⇒
   * `indeterminate`; anything else ⇒ `indeterminate`). Override ONLY where the truth table truly
   * differs (Trakstar `400` = absent; SmartRecruiters `200 + totalFound:0` = indeterminate).
   */
  classifyProbe?(status: number, body: unknown): ProbeOutcome;

  /** Build the request for page `cursor` (`null` ⇒ first page). Pure URL/init construction. */
  jobsRequest(ctx: SourceContext, cursor: Cursor | null): JobsRequest;

  /** Pull the untrusted jobs array out of one page's parsed body. Throws on a bad envelope. */
  locate(body: unknown, ctx: SourceContext): unknown[];

  /**
   * Map ONE raw item → NormalizedJob, or `null` to skip+count (never throw on bad data).
   * MUST emit a FULLY-VALID job even for hydrate-only sources — e.g. SmartRecruiters
   * reconstructs `applyUrl` and sets `descriptionText: ""` here, which `hydrate` then
   * patches. That is what lets a hydrate failure degrade gracefully (runAdapter keeps the
   * already-valid job) with no plumbing changes.
   */
  mapItem(raw: unknown, ctx: SourceContext): NormalizedJob | null;

  /**
   * Compute the next cursor from THIS page's body + the cursor that produced it (and the
   * page's item count). Return `null` to stop. OMIT entirely ⇒ a single unpaginated fetch
   * (Greenhouse, Lever, Ashby, Workable).
   */
  nextCursor?(body: unknown, prevCursor: Cursor | null, pageItemCount: number): Cursor | null;

  /**
   * OPTIONAL per-item enrichment via a SECOND fetch (the N+1 case — SmartRecruiters).
   * Given an already-mapped job + its raw item, fetch extra data through the injected
   * resilient `fetchJson` and return a PATCH to merge. OMIT ⇒ no second fetch (Greenhouse,
   * Lever, Ashby; Workable hydrates inline via a `jobsRequest` query param instead).
   * runAdapter runs these through a bounded-concurrency pool and tolerates per-item failure.
   */
  hydrate?(
    job: NormalizedJob,
    raw: unknown,
    ctx: SourceContext,
    fetchJson: FetchJson,
  ): Promise<Partial<NormalizedJob>>;
}

/** What every descriptor method receives: the branded slug + the original caller input. */
export interface SourceContext {
  /** Platform-canonical, branded slug (the output of `normalizeSlug`). */
  slug: CompanySlug;
  /** The raw caller-supplied slug, pre-normalization (for adapters that need the original). */
  rawSlug: string;
}

/** A single page request. Omit `init` ⇒ GET (all Launch-5 ATS are GET-only). */
export interface JobsRequest {
  url: string;
  init?: RequestInit;
}

/** The resilient fetch runAdapter hands to `hydrate` — same retry/backoff/JSON guard as the list fetch. */
export type FetchJson = (req: JobsRequest) => Promise<unknown>;

/**
 * Pagination cursor. Only OFFSET is used by the Launch-5 (Lever defensively, SmartRecruiters
 * always). A `page` kind can be added as another union member when a page-number ATS lands;
 * the loop and `jobsRequest` already accept any Cursor shape, so no plumbing changes.
 */
export type Cursor = { kind: "offset"; offset: number };
