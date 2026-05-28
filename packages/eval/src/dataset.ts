/**
 * Labeled-set loader + validator (Phase 5). The dataset is JSONL — one `EvalExample` per
 * line — chosen over a single JSON array or YAML so the set grows by APPENDING (a clean
 * one-line git diff per added label) with no parser dependency. The validator is the guard
 * against hand-authoring mistakes: it runs at the boundary and throws with a line number, so
 * a typo'd label fails loudly at load instead of silently scoring wrong. Blank lines and
 * `//` / `#` comment lines are skipped so the file can carry section headers.
 */
import { readFileSync } from "node:fs";

import { isRecord } from "@opusfinder/shared";

import { profileEmbeddingText } from "./profile";
import type { EvalExample, EvalJob, EvalProfile } from "./types";

/** Read a JSONL dataset file and return validated examples. */
export function loadDataset(path: string): EvalExample[] {
  return parseDatasetLines(readFileSync(path, "utf8"), path);
}

/**
 * Parse + validate a JSONL string into examples. Separated from file I/O so it is unit-
 * testable on inline strings (see scripts/test-metrics.ts) without touching the filesystem.
 * `label` is a human-facing prefix for error messages (a path, or anything).
 */
export function parseDatasetLines(text: string, label = "dataset"): EvalExample[] {
  const examples: EvalExample[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("#")) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${label}:${i + 1}: invalid JSON — ${msg}`, { cause: err });
    }
    examples.push(validateExample(parsed, `${label}:${i + 1}`));
  });
  return examples;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const isNumberArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((x) => typeof x === "number");

function validateExample(value: unknown, at: string): EvalExample {
  if (!isRecord(value)) throw new Error(`${at}: expected an object.`);

  const profile = validateProfile(value.profile, at);

  if (!Array.isArray(value.candidateJobs))
    throw new Error(`${at}: candidateJobs must be an array.`);
  const candidateJobs = value.candidateJobs.map((j, idx) =>
    validateJob(j, `${at} candidateJobs[${idx}]`),
  );

  if (!isNumberArray(value.expectedGoodIds)) {
    throw new Error(`${at}: expectedGoodIds must be a number[].`);
  }
  // Job ids are integers (validateJob requires it), so a non-integer good id can never match a
  // pool id — reject it here with a precise message instead of the vaguer "absent from candidateJobs".
  if (!value.expectedGoodIds.every((g) => Number.isInteger(g))) {
    throw new Error(`${at}: expectedGoodIds must contain only integers.`);
  }
  // Every relevant id MUST be present in the pool. A label pointing at a job absent from
  // candidateJobs is a data bug that would silently cap recall below 1 forever — catch it
  // here, not as a mysterious metric.
  const poolIds = new Set(candidateJobs.map((j) => j.id));
  // Reject duplicate candidate ids. A repeat passes assertPermutation (both sides sort equal)
  // but double-counts a relevant hit in scoreRanking — recall can exceed 1 and every metric
  // inflates. Catching it here is the validator's job: silent label corruption, not a crash.
  if (poolIds.size !== candidateJobs.length) {
    throw new Error(`${at}: candidateJobs contains duplicate job ids.`);
  }
  for (const gid of value.expectedGoodIds) {
    if (!poolIds.has(gid)) {
      throw new Error(
        `${at}: expectedGoodIds contains ${gid}, which is absent from candidateJobs.`,
      );
    }
  }

  const example: EvalExample = { profile, candidateJobs, expectedGoodIds: value.expectedGoodIds };
  if (value.notes !== undefined) {
    if (typeof value.notes !== "string") throw new Error(`${at}: notes must be a string.`);
    example.notes = value.notes;
  }
  return example;
}

function validateProfile(value: unknown, at: string): EvalProfile {
  if (!isRecord(value)) throw new Error(`${at}: profile must be an object.`);
  if (typeof value.id !== "string" || value.id.trim() === "") {
    throw new Error(`${at}: profile.id must be a non-empty string.`);
  }
  if (typeof value.summary !== "string")
    throw new Error(`${at}: profile.summary must be a string.`);
  if (!isStringArray(value.skills)) throw new Error(`${at}: profile.skills must be a string[].`);
  if (!isStringArray(value.targetRoles))
    throw new Error(`${at}: profile.targetRoles must be a string[].`);

  const profile: EvalProfile = {
    id: value.id,
    summary: value.summary,
    skills: value.skills,
    targetRoles: value.targetRoles,
  };

  // Assert the ACTUAL composer's output is non-empty instead of re-deriving the "empty" rule:
  // profileEmbeddingText is the query text the embedder sees, and it 400s on "". Checking its
  // output keeps this guard correct if the composition (weighting, fields) ever changes.
  // (profileEmbeddingText is eval-local and dependency-light, so this stays off the db path.)
  if (profileEmbeddingText(profile).trim() === "") {
    throw new Error(
      `${at}: profile has no embeddable content (summary, skills, and targetRoles compose to "").`,
    );
  }
  if (value.preferences !== undefined) {
    profile.preferences = validatePreferences(value.preferences, at);
  }
  return profile;
}

function validatePreferences(value: unknown, at: string): NonNullable<EvalProfile["preferences"]> {
  if (!isRecord(value)) throw new Error(`${at}: preferences must be an object.`);
  const prefs: NonNullable<EvalProfile["preferences"]> = {};
  if (value.remote !== undefined) {
    if (typeof value.remote !== "boolean")
      throw new Error(`${at}: preferences.remote must be a boolean.`);
    prefs.remote = value.remote;
  }
  if (value.locations !== undefined) {
    if (!isStringArray(value.locations))
      throw new Error(`${at}: preferences.locations must be a string[].`);
    prefs.locations = value.locations;
  }
  if (value.minSalary !== undefined) {
    if (typeof value.minSalary !== "number")
      throw new Error(`${at}: preferences.minSalary must be a number.`);
    prefs.minSalary = value.minSalary;
  }
  return prefs;
}

function validateJob(value: unknown, at: string): EvalJob {
  if (!isRecord(value)) throw new Error(`${at}: must be an object.`);
  if (typeof value.id !== "number" || !Number.isInteger(value.id)) {
    throw new Error(`${at}: id must be an integer.`);
  }
  if (typeof value.title !== "string") throw new Error(`${at}: title must be a string.`);
  if (typeof value.descriptionText !== "string") {
    throw new Error(`${at}: descriptionText must be a string.`);
  }
  // Every candidate must have embeddable content. This is a deliberately LIGHTWEIGHT, db-free
  // mirror of jobEmbeddingText (title + description; blank on BOTH composes to "" and the embedder
  // 400s) — kept db-free on purpose so loadDataset never pulls @opusfinder/db onto the random /
  // fixture path. The AUTHORITATIVE, drift-proof check (asserting jobEmbeddingText's actual output)
  // lives in embeddingRanker, where the composer is already imported and only loaded when embedding.
  if (value.title.trim() === "" && value.descriptionText.trim() === "") {
    throw new Error(
      `${at}: job ${value.id} has no embeddable content (title and descriptionText are both empty).`,
    );
  }
  const job: EvalJob = { id: value.id, title: value.title, descriptionText: value.descriptionText };
  if (value.locations !== undefined) {
    if (!isStringArray(value.locations)) throw new Error(`${at}: locations must be a string[].`);
    job.locations = value.locations;
  }
  if (value.remote !== undefined) {
    if (typeof value.remote !== "boolean") throw new Error(`${at}: remote must be a boolean.`);
    job.remote = value.remote;
  }
  return job;
}
