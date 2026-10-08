import type { NormalizedJob, SourceName } from "@opusfinder/shared";

import { ashbyAdapter } from "./ashby";
import { gemAdapter } from "./gem";
import { greenhouseAdapter } from "./greenhouse";
import { leverAdapter } from "./lever";
import { pinpointAdapter } from "./pinpoint";
import { recruiteeAdapter } from "./recruitee";
import { runAdapter } from "./run-adapter";
import type { RunAdapterOptions } from "./run-adapter";
import { smartRecruitersAdapter } from "./smartrecruiters";
import { trakstarAdapter } from "./trakstar";
import type { SourceAdapter } from "./types";
import { workableAdapter } from "./workable";

/**
 * The source-name → adapter registry. Typed `Record<SourceName, SourceAdapter>` so a
 * forgotten adapter is a COMPILE error and the union stays exhaustive — the strongest
 * guarantee the closed `SourceName` union buys us.
 */
export const adapters: Record<SourceName, SourceAdapter> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
  workable: workableAdapter,
  smartrecruiters: smartRecruitersAdapter,
  pinpoint: pinpointAdapter,
  gem: gemAdapter,
  recruitee: recruiteeAdapter,
  trakstar: trakstarAdapter,
};

/** The known source names (registry keys), for CLI validation + iteration. */
export const SOURCE_NAMES = Object.keys(adapters) as SourceName[];

/**
 * Sources whose API matches board ids case-INSENSITIVELY while `normalizeSlug` preserves casing (verified
 * live 2026-10-08: `boschgroup`/`BoschGroup` and `mapbox`/`Mapbox` list the same postings). Discovery folds
 * these slugs' case when matching, and the `companies_source_lower_slug_uq` index rejects a case-variant
 * insert from any writer, to keep one row per board. That index keeps its own copy of this list (db can't
 * import sources), so adding a source also needs that list + a migration; registry.test.ts fails until they
 * match. A source whose `normalizeSlug` already lowercases doesn't need listing.
 */
export const CASE_INSENSITIVE_SLUG_SOURCES: ReadonlySet<SourceName> = new Set([
  "ashby",
  "smartrecruiters",
]);

/** An adapter's politeness group for ingestion pacing — its declared `pacingKey`, else its source. */
export function pacingKeyOf(adapter: SourceAdapter): string {
  return adapter.pacingKey ?? adapter.source;
}

/** Pacing key → its pace: the largest `paceMs` its adapters declare (0 if none does). */
export function pacesByKey(list: readonly SourceAdapter[]): Map<string, number> {
  const paces = new Map<string, number>();
  for (const adapter of list) {
    const key = pacingKeyOf(adapter);
    paces.set(key, Math.max(paces.get(key) ?? 0, adapter.paceMs ?? 0));
  }
  return paces;
}

// Built once: the registry is fixed at import.
const PACE_BY_KEY = pacesByKey(Object.values(adapters));

/** A pacing key's own pace (see {@link pacesByKey}). */
export function paceMsOf(pacingKey: string): number {
  return PACE_BY_KEY.get(pacingKey) ?? 0;
}

/** Narrow an arbitrary string to a known SourceName. */
export function isSourceName(value: string): value is SourceName {
  return Object.prototype.hasOwnProperty.call(adapters, value);
}

/**
 * The adapter for `source`, or a clear `unknown source "<x>"` error — never an undefined adapter that
 * fails later as an opaque TypeError. A `companies` row is typed SourceName but read from the DB, so a
 * stale or hand-written source can still arrive here. Shape-only message (the source string only).
 */
export function adapterFor(source: string): SourceAdapter {
  if (!isSourceName(source)) throw new Error(`unknown source "${source}"`);
  return adapters[source];
}

/**
 * Fetch + normalize all live postings for one board on `source`. The single public entry
 * point: `runAdapter` drives the descriptor (slug normalization → pagination → fetch →
 * map → hydrate). An unknown source rejects with {@link adapterFor}'s error.
 */
export async function fetchJobs(
  source: SourceName,
  slug: string,
  opts?: RunAdapterOptions,
): Promise<NormalizedJob[]> {
  return runAdapter(adapterFor(source), slug, opts);
}
