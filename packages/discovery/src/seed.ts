/**
 * The discovery seed: outscal/OpenJobs `data/companies_v2.json` — ~12k gaming/tech companies, each
 * with an `ats_links[]` of public job-board URLs (lane B1). Pinned to a commit SHA so a local
 * bootstrap run is deterministic and immune to an upstream schema/file move; bump SEED_SHA to refresh.
 * CC-BY-NC dataset — we read only the public board URLs to validate slugs. Many `ats_links` are vanity
 * careers pages rather than recognizable ATS boards, so most records resolve to no adapter (expected).
 */
const SEED_SHA = "cdcc533521afb61f4e60657b3dbe06e484ccddcf"; // outscal/OpenJobs main @ 2026-04-22
export const SEED_URL = `https://raw.githubusercontent.com/outscal/OpenJobs/${SEED_SHA}/data/companies_v2.json`;

/**
 * One seed record — only the fields discovery reads (`name` for logging, `ats_links` for resolution);
 * the rest (game_genre, tech_stack, countries, list_urls, …) are ignored. Typed LOOSELY because the
 * JSON is untrusted: the resolver guards every field at the use site (Array.isArray, typeof string).
 */
export interface CompanyRecord {
  name?: string;
  ats_links?: string[];
}

/**
 * Fetch + parse the pinned seed into records. Validates only the top-level array shape; per-record
 * fields are validated downstream by the resolver. A non-2xx or non-array body THROWS — a broken seed
 * should fail the run loudly, not silently yield zero candidates. Streams the whole file into memory
 * (a few MB for ~12k records), which is fine for a local bootstrap script.
 */
export async function loadSeed(url: string = SEED_URL): Promise<CompanyRecord[]> {
  const res = await fetch(url);
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Seed fetch failed: ${res.status} ${res.statusText}`);
  }
  const data: unknown = await res.json();
  if (!Array.isArray(data)) {
    throw new Error("Seed is not a JSON array of company records");
  }
  return data as CompanyRecord[];
}
