/**
 * Shared plumbing for the pooled-labeling flow: the per-profile label files
 * (data/profiles/<id>.json — committed) and their candidate-pool snapshots
 * (data/pools/<id>.json — gitignored working artifacts, like candidates-export.json).
 *
 * One label file per profile (instead of one LABELS array in build-dataset.ts) so refining one
 * example's labels is a one-file diff at 12+ examples. Validation here is deliberately LIGHT
 * (shape + id/filename agreement): parseDatasetLines is the authoritative gate and re-validates
 * every example at build:dataset time; duplicating its rules here would let the two drift.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { isRecord } from "@opusfinder/shared";

import { PKG_ROOT, relativeToPkg } from "../src/runner";
import type { EvalProfile } from "../src/types";

export const PROFILES_DIR = join(PKG_ROOT, "data", "profiles");
export const POOLS_DIR = join(PKG_ROOT, "data", "pools");

/** One committed label file: the anonymized profile, the owner-authoritative goodIds
 *  (ids into the pool snapshot), and the labeling rationale. */
export interface LabeledProfileFile {
  profile: EvalProfile;
  goodIds: number[];
  notes: string;
}

/** A pool member: the frozen EvalJob fields + nomination provenance. `arms` records every arm
 *  that surfaced it (a job found by both voyage and fts carries both tags). */
export interface PoolCandidate {
  id: number;
  title: string;
  descriptionText: string;
  locations: string[];
  remote: boolean;
  contentSignature: string | null;
  arms: ("voyage" | "fts" | "random")[];
  voyageRank?: number;
  voyageDistance?: number;
  ftsRank?: number;
}

/** data/pools/<id>.json. No timestamp (the eligible-count is the "when" proxy, mirroring the
 *  hnsw-recall report convention); regeneration against a changed corpus is a deliberate refresh
 *  that forces relabeling (build:dataset fails loud on a goodId absent from the new pool). */
export interface PoolFile {
  profileId: string;
  arms: { voyageK: number; ftsK: number; randomK: number; recencyDays: number };
  corpus: { eligibleJobs: number };
  candidates: PoolCandidate[];
}

export function poolPath(profileId: string): string {
  return join(POOLS_DIR, `${profileId}.json`);
}

function assertLabeledShape(value: unknown, at: string): asserts value is LabeledProfileFile {
  if (!isRecord(value)) throw new Error(`${at}: expected an object.`);
  if (!isRecord(value.profile) || typeof value.profile.id !== "string" || value.profile.id.trim() === "") {
    throw new Error(`${at}: profile.id must be a non-empty string.`);
  }
  if (!Array.isArray(value.goodIds) || !value.goodIds.every((g) => typeof g === "number")) {
    throw new Error(`${at}: goodIds must be a number[].`);
  }
  if (typeof value.notes !== "string") throw new Error(`${at}: notes must be a string.`);
}

export function loadProfileFile(path: string): LabeledProfileFile {
  const at = basename(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${at}: invalid JSON (${err instanceof Error ? err.message : String(err)}).`, {
      cause: err,
    });
  }
  assertLabeledShape(parsed, at);
  // The filename IS the profile id (poolPath keys on it) — a mismatch would silently pair a
  // profile with another profile's pool.
  const expected = basename(path).replace(/\.json$/, "");
  if (parsed.profile.id !== expected) {
    throw new Error(`${at}: profile.id "${parsed.profile.id}" must match the filename ("${expected}").`);
  }
  return parsed;
}

/** All label files, sorted by profile id so build output order is stable run-to-run. */
export function loadAllProfileFiles(): LabeledProfileFile[] {
  if (!existsSync(PROFILES_DIR)) return [];
  return readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => loadProfileFile(join(PROFILES_DIR, f)));
}

export function loadPoolFile(profileId: string): PoolFile {
  const path = poolPath(profileId);
  if (!existsSync(path)) {
    throw new Error(
      `${relativeToPkg(path)} not found — run \`pnpm --filter @opusfinder/eval build:pool\` first.`,
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || parsed.profileId !== profileId || !Array.isArray(parsed.candidates)) {
    throw new Error(
      `${relativeToPkg(path)}: not a pool file for "${profileId}" — rebuild with build:pool.`,
    );
  }
  return parsed as unknown as PoolFile;
}
