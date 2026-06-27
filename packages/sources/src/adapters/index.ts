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

/** Narrow an arbitrary string to a known SourceName. */
export function isSourceName(value: string): value is SourceName {
  return Object.prototype.hasOwnProperty.call(adapters, value);
}

/**
 * Fetch + normalize all live postings for one board on `source`. The single public entry
 * point: `runAdapter` drives the descriptor (slug normalization → pagination → fetch →
 * map → hydrate).
 */
export function fetchJobs(
  source: SourceName,
  slug: string,
  opts?: RunAdapterOptions,
): Promise<NormalizedJob[]> {
  return runAdapter(adapters[source], slug, opts);
}
