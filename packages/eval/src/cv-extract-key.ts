/**
 * The CV-extraction key (data/cv-extract/keys/<id>.json): for each test CV, what a correct extraction
 * holds, written from the CV itself and checked by the owner. `cv-extract score` compares an extracted
 * profile to it field by field. A field is right only when everything the key requires is present and
 * nothing the key does not allow is; there is no partial credit inside a field.
 *
 * Text is compared after lowercasing and replacing punctuation with spaces, and an alias matches when
 * its words appear in the text as whole words ("rn" matches "RN Staff Nurse", not "intern").
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  CREDENTIAL_STATUSES,
  EDUCATION_LEVELS,
  type CvFacts,
  type StructuredProfile,
} from "@opusfinder/shared";

export const CV_GROUPS = ["healthcare-licensed", "hourly-shift", "other-non-tech", "tech"] as const;
export type CvGroup = (typeof CV_GROUPS)[number];

/** The fields a profile is scored on. `protected` is scored only for CVs whose key lists forbidden terms. */
export const SCORED_FIELDS = [
  "summary",
  "skills",
  "targetRoles",
  "credentials",
  "education",
  "yearsExperience",
  "languages",
  "workAuthorization",
  "protected",
] as const;
export type ScoredField = (typeof SCORED_FIELDS)[number];

/** The fields that only exist from extraction version 2 on. */
export const FACT_FIELDS: readonly ScoredField[] = [
  "credentials",
  "education",
  "yearsExperience",
  "languages",
  "workAuthorization",
];

const aliases = z.array(z.string().min(1)).min(1);
/** `"any"` turns a check off where the CV is genuinely unclear. */
const any = z.literal("any");

const KeyCredential = z.strictObject({
  /** The credential's name must contain one of these. */
  match: aliases,
  /** ...and one of these, to tell apart two credentials of one kind (a state, a class). */
  also: aliases.optional(),
  /** Unchecked unless given: `null` means the CV names no issuer. */
  issuer: aliases.nullable().optional(),
  /** Defaults to `null`: the CV does not state a status. */
  status: z.enum(CREDENTIAL_STATUSES).nullable().or(any).default(null),
  /** Defaults to `null`: the CV gives no expiry. "YYYY" or "YYYY-MM". */
  expires: z.string().nullable().or(any).default(null),
  /** An optional entry may appear any number of times or not at all. */
  optional: z.literal(true).optional(),
});

const KeyEducation = z.strictObject({
  level: z.array(z.enum(EDUCATION_LEVELS)).min(1),
  /** Unchecked unless given. */
  field: aliases.optional(),
  completed: z.boolean().or(any).default(true),
  optional: z.literal(true).optional(),
});

const KeyYears = z.strictObject({
  years: z.number(),
  /** Where the figure belongs: the total, a role family, or either when the CV's scope is arguable. */
  slot: z.enum(["total", "family", "either"]),
  optional: z.literal(true).optional(),
});

const KeyLanguage = z.strictObject({
  match: aliases,
  /** Unchecked unless given. */
  proficiency: aliases.optional(),
  optional: z.literal(true).optional(),
});

const CvKeySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  group: z.enum(CV_GROUPS),
  /** Where the CV comes from: a path inside a public dataset on Hugging Face. */
  source: z.strictObject({ dataset: z.string(), path: z.string() }),
  expected: z.strictObject({
    /** Each inner list must be met by the summary: it contains one of the list's aliases. */
    summary: z.array(aliases),
    /** Each inner list must be met by some skill. */
    skills: z.array(aliases),
    /** The first target role contains one of these. */
    targetRoles: aliases,
    credentials: z.array(KeyCredential),
    education: z.array(KeyEducation),
    years: z.array(KeyYears),
    languages: z.array(KeyLanguage),
    /** `null`: the CV makes no statement. Otherwise the statement contains one of these. */
    workAuthorization: aliases.nullable(),
    /** Terms that must appear nowhere in the profile: a licence number, a protected attribute. */
    forbidden: z.array(z.string().min(1)).default([]),
  }),
  /** What the owner should look at: the entries where another reading of the CV is defensible. */
  judgementCalls: z.array(z.string()),
});
export type CvKey = z.infer<typeof CvKeySchema>;

/** Every key in `dir`, sorted by id. Throws on a malformed key, naming the file. */
export function loadCvKeys(dir: string): CvKey[] {
  const keys = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const parsed = CvKeySchema.safeParse(JSON.parse(readFileSync(join(dir, file), "utf8")));
      if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
      if (`${parsed.data.id}.json` !== file)
        throw new Error(`${file}: id "${parsed.data.id}" ≠ file name`);
      return parsed.data;
    });
  return keys;
}

export interface FieldResult {
  field: ScoredField;
  correct: boolean;
  /** Why it is wrong; empty when correct. */
  problems: string[];
}

const EMPTY_FACTS: CvFacts = {
  credentials: [],
  education: [],
  yearsExperience: { total: null, byRoleFamily: [] },
  languages: [],
  workAuthorization: null,
};

/** Rounding a stated "5 years 7 months" either way stays inside this. */
const YEARS_TOLERANCE = 0.6;

/**
 * Score one extracted profile against its key. A profile without `facts` (extraction version 1) is
 * scored as stating none, so it is right exactly where the CV is silent.
 */
export function scoreProfile(profile: StructuredProfile, key: CvKey): FieldResult[] {
  const facts = profile.facts ?? EMPTY_FACTS;
  const e = key.expected;
  const results: FieldResult[] = [
    result("summary", unmetGroups(e.summary, [profile.summary])),
    result("skills", unmetGroups(e.skills, profile.skills)),
    result(
      "targetRoles",
      matchesAny(profile.targetRoles[0] ?? "", e.targetRoles)
        ? []
        : [`first role "${profile.targetRoles[0] ?? ""}" is none of: ${e.targetRoles.join(", ")}`],
    ),
    result("credentials", credentialProblems(facts.credentials, e.credentials)),
    result("education", educationProblems(facts.education, e.education)),
    result("yearsExperience", yearsProblems(facts.yearsExperience, e.years)),
    result("languages", languageProblems(facts.languages, e.languages)),
    result(
      "workAuthorization",
      workAuthorizationProblems(facts.workAuthorization, e.workAuthorization),
    ),
  ];
  if (e.forbidden.length > 0) {
    const text = JSON.stringify(profile);
    results.push(
      result(
        "protected",
        e.forbidden.filter((term) => contains(text, term)).map((term) => `contains "${term}"`),
      ),
    );
  }
  return results;
}

function result(field: ScoredField, problems: string[]): FieldResult {
  return { field, correct: problems.length === 0, problems };
}

function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}
function contains(text: string, alias: string): boolean {
  return normalize(text).includes(normalize(alias));
}
function matchesAny(text: string, list: readonly string[]): boolean {
  return list.some((alias) => contains(text, alias));
}

function unmetGroups(groups: readonly (readonly string[])[], texts: readonly string[]): string[] {
  return groups
    .filter((group) => !texts.some((text) => matchesAny(text, group)))
    .map((group) => `nothing matches: ${group.join(" / ")}`);
}

/**
 * Pair extracted items with key entries. Every required entry needs its own item (a maximum bipartite
 * matching, so "Network+" is not spent on the entry only "CCNA (… Network Associate)" can fill), and
 * every item left over must be allowed by an optional entry. Returns the pairs plus the problems.
 */
function pair<Item, Entry extends { optional?: true }>(
  items: readonly Item[],
  entries: readonly Entry[],
  matches: (item: Item, entry: Entry) => boolean,
  describe: { item: (item: Item) => string; entry: (entry: Entry) => string },
): { pairs: [Item, Entry][]; problems: string[] } {
  const required = entries.filter((entry) => !entry.optional);
  const optional = entries.filter((entry) => entry.optional);
  const allowedAnyway = (item: Item) => optional.some((entry) => matches(item, entry));
  // Items no optional entry would allow are offered first, so a required entry takes those when it can.
  const order = items
    .map((_, i) => i)
    .sort((a, b) => Number(allowedAnyway(items[a]!)) - Number(allowedAnyway(items[b]!)));
  const takenBy = new Map<number, number>(); // item index → required index
  const tryAssign = (r: number, seen: Set<number>): boolean => {
    for (const i of order) {
      if (seen.has(i) || !matches(items[i]!, required[r]!)) continue;
      seen.add(i);
      const holder = takenBy.get(i);
      if (holder === undefined || tryAssign(holder, seen)) {
        takenBy.set(i, r);
        return true;
      }
    }
    return false;
  };
  const problems: string[] = [];
  required.forEach((entry, r) => {
    if (!tryAssign(r, new Set())) problems.push(`missing: ${describe.entry(entry)}`);
  });
  const pairs: [Item, Entry][] = [];
  items.forEach((item, i) => {
    const r = takenBy.get(i);
    if (r !== undefined) pairs.push([item, required[r]!]);
    else if (!allowedAnyway(item)) problems.push(`unexpected: ${describe.item(item)}`);
  });
  return { pairs, problems };
}

type KeyCredentialEntry = CvKey["expected"]["credentials"][number];

function credentialProblems(
  items: CvFacts["credentials"],
  entries: readonly KeyCredentialEntry[],
): string[] {
  const { pairs, problems } = pair(
    items,
    entries,
    (item, entry) =>
      matchesAny(item.name, entry.match) && (!entry.also || matchesAny(item.name, entry.also)),
    {
      item: (item) => item.name,
      entry: (entry) => [entry.match[0], entry.also?.[0]].filter(Boolean).join(", "),
    },
  );
  for (const [item, entry] of pairs) {
    if (entry.status !== "any" && item.status !== entry.status) {
      problems.push(`${item.name}: status ${item.status} ≠ ${entry.status}`);
    }
    if (entry.expires !== "any" && !sameExpiry(item.expires, entry.expires)) {
      problems.push(`${item.name}: expires ${item.expires} ≠ ${entry.expires}`);
    }
    if (entry.issuer === null && item.issuer !== null) {
      problems.push(`${item.name}: issuer "${item.issuer}" but the CV names none`);
    }
    if (entry.issuer && !(item.issuer && matchesAny(item.issuer, entry.issuer))) {
      problems.push(`${item.name}: issuer ${item.issuer} ≠ ${entry.issuer[0]}`);
    }
  }
  return problems;
}

/** Same year, and the same month where both give one ("12/2016" and "2016-12" agree). */
function sameExpiry(actual: string | null, expected: string | null): boolean {
  if (actual === null || expected === null) return actual === expected;
  const a = readYearMonth(actual);
  const b = readYearMonth(expected);
  if (!a || !b || a.year !== b.year) return false;
  return a.month === undefined || b.month === undefined || a.month === b.month;
}
function readYearMonth(text: string): { year: number; month?: number } | undefined {
  const iso = /(\d{4})-(\d{1,2})/.exec(text);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]) };
  const slash = /(\d{1,2})\/(\d{4})/.exec(text);
  if (slash) return { year: Number(slash[2]), month: Number(slash[1]) };
  const year = /\d{4}/.exec(text);
  return year ? { year: Number(year[0]) } : undefined;
}

function educationProblems(
  items: CvFacts["education"],
  entries: CvKey["expected"]["education"],
): string[] {
  const label = (item: CvFacts["education"][number]) =>
    [item.level, item.field].filter(Boolean).join(" ");
  const { pairs, problems } = pair(
    items,
    entries,
    (item, entry) =>
      entry.level.includes(item.level) &&
      (!entry.field || matchesAny(item.field ?? "", entry.field)),
    {
      item: label,
      entry: (entry) => [entry.level.join("|"), entry.field?.[0]].filter(Boolean).join(" "),
    },
  );
  for (const [item, entry] of pairs) {
    if (entry.completed !== "any" && item.completed !== entry.completed) {
      problems.push(`${label(item)}: completed ${item.completed} ≠ ${entry.completed}`);
    }
  }
  return problems;
}

function yearsProblems(
  actual: CvFacts["yearsExperience"],
  entries: CvKey["expected"]["years"],
): string[] {
  const claims = [
    ...(actual.total === null ? [] : [{ slot: "total", years: actual.total, label: "total" }]),
    ...actual.byRoleFamily.map((r) => ({ slot: "family", years: r.years, label: r.roleFamily })),
  ];
  return pair(
    claims,
    entries,
    (claim, entry) =>
      Math.abs(claim.years - entry.years) <= YEARS_TOLERANCE &&
      (entry.slot === "either" || entry.slot === claim.slot),
    {
      item: (claim) => `${claim.years} (${claim.label})`,
      entry: (entry) => `${entry.years} (${entry.slot})`,
    },
  ).problems;
}

function languageProblems(
  items: CvFacts["languages"],
  entries: CvKey["expected"]["languages"],
): string[] {
  const { pairs, problems } = pair(
    items,
    entries,
    (item, entry) => matchesAny(item.language, entry.match),
    {
      item: (item) => item.language,
      entry: (entry) => entry.match[0]!,
    },
  );
  for (const [item, entry] of pairs) {
    if (entry.proficiency && !matchesAny(item.proficiency ?? "", entry.proficiency)) {
      problems.push(`${item.language}: proficiency ${item.proficiency} ≠ ${entry.proficiency[0]}`);
    }
  }
  return problems;
}

function workAuthorizationProblems(
  actual: string | null,
  expected: readonly string[] | null,
): string[] {
  if (expected === null)
    return actual === null ? [] : [`"${actual}" but the CV makes no statement`];
  if (actual === null) return [`missing: ${expected[0]}`];
  return matchesAny(actual, expected)
    ? []
    : [`"${actual}" matches none of: ${expected.join(" / ")}`];
}

/**
 * How many of the key's required credentials are named anywhere in the embedded text (summary + skills).
 * It is the one thing a version-1 profile can be compared on: whether a licence survived at all.
 */
export function credentialsMentioned(
  profile: StructuredProfile,
  key: CvKey,
): { found: number; of: number } {
  const required = key.expected.credentials.filter((c) => !c.optional);
  const texts = [profile.summary, ...profile.skills];
  return {
    found: required.filter((c) => texts.some((t) => matchesAny(t, c.match))).length,
    of: required.length,
  };
}

export interface Tally {
  correct: number;
  total: number;
}
export interface ScoreSummary {
  overall: Tally;
  /** The fields version 1 has too (summary, skills, target roles, protected). */
  sharedFields: Tally;
  /** The fields added in version 2. */
  factFields: Tally;
  byGroup: Record<CvGroup, Tally>;
  byField: Partial<Record<ScoredField, Tally>>;
  credentialsMentioned: Tally;
}

/** Add up per-CV results into the totals a report shows. */
export function summarize(
  scored: readonly { key: CvKey; profile: StructuredProfile; results: readonly FieldResult[] }[],
): ScoreSummary {
  const tally = (): Tally => ({ correct: 0, total: 0 });
  const add = (t: Tally, correct: boolean) => {
    t.total += 1;
    if (correct) t.correct += 1;
  };
  const summary: ScoreSummary = {
    overall: tally(),
    sharedFields: tally(),
    factFields: tally(),
    byGroup: {
      "healthcare-licensed": tally(),
      "hourly-shift": tally(),
      "other-non-tech": tally(),
      tech: tally(),
    },
    byField: {},
    credentialsMentioned: tally(),
  };
  for (const { key, profile, results } of scored) {
    for (const r of results) {
      add(summary.overall, r.correct);
      add(FACT_FIELDS.includes(r.field) ? summary.factFields : summary.sharedFields, r.correct);
      add(summary.byGroup[key.group], r.correct);
      add((summary.byField[r.field] ??= tally()), r.correct);
    }
    const mentioned = credentialsMentioned(profile, key);
    summary.credentialsMentioned.correct += mentioned.found;
    summary.credentialsMentioned.total += mentioned.of;
  }
  return summary;
}
