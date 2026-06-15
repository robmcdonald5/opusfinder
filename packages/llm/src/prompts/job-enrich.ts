import { z } from "zod";

import { type JobEnrichment, SALARY_PERIODS } from "@opusfinder/shared";

/**
 * Phase F4 job-side enrichment — the prompt + schema + PURE extractor core that turn a job's own title +
 * description prose into the structured {@link JobEnrichment} columns (a numeric YoE band + a salary range).
 * Deliberately deps-only `@opusfinder/shared`/`zod` (NO `./generate-object` import): the real `generateObject`
 * call is INJECTED (the rerank pure-core / injected-call DI pattern, cf. `cv-extract.ts`), so the Phase-4e
 * accuracy eval scores EXACTLY the prompt + schema + composer production runs — only the transport (the live
 * API vs a recorded/stub call) differs.
 */

/**
 * The strict null-when-absent system prompt — the INVERSE of `CV_STRUCTURE_SYSTEM`'s "return the
 * best-supported minimal value" (`cv-extract.ts`). Here a missing field MUST be `null`, never inferred: a
 * hallucinated salary/level silently poisons a DETERMINISTIC filter (the deferred F4-FILTER), where a CV
 * best-guess only nudges a soft embedding — so the contract is the opposite. Sized for quality, NOT padded to
 * reach Haiku's ~4096-token cache prefix (it sits below it, so `cacheSystem` is a silent no-op — do not pad).
 */
export const JOB_ENRICH_SYSTEM = `You extract structured hiring facts from a single job posting's title and description. Return ONLY the structured fields.

Ground EVERYTHING in the provided text. Return null for any field the text does not state or directly support. NEVER infer, guess, or invent a salary, currency, pay period, or years-of-experience the posting does not support — a wrong value is worse than null, because a downstream filter trusts these fields literally.

Fields:

yoeMin / yoeMax — the years of professional experience the ROLE requires, as a numeric band. Read explicit phrasing first ("3+ years" -> min 3, max null; "5-8 years" -> min 5, max 8; "at least 2 years" -> min 2, max null). If no years are stated but the level is unambiguous from the title and scope language, you MAY map a clear seniority signal to a conservative band (intern / new grad -> 0-1; junior -> 0-2; mid-level -> 2-5; senior -> 5-8; staff or principal -> min 8, max null) — but ONLY when the level is clear; otherwise both null. Never output a band wider than the text supports.

salaryMin / salaryMax — the posted BASE-pay range as whole numbers in salaryCurrency units (strip separators and symbols: "$120,000" -> 120000; "150k" -> 150000). A single figure sets both min and max to that value. Bonus, equity, and benefits are NOT base pay — ignore them. If no pay is stated, both null.

salaryCurrency — the ISO-4217 3-letter code for the salary range ("$" in a US posting -> "USD", "£" -> "GBP", "€" -> "EUR"). null when no salary is stated or the currency is genuinely ambiguous.

salaryPeriod — the unit of the salary range, one of: year, month, week, day, hour. An annual figure -> "year"; "$80/hr" -> "hour". null when no salary is stated.

Rules:
- null is the correct, expected answer for most postings — explicit comp and years are often absent. Returning null is never penalized; guessing is.
- The salary fields move together: if salaryMin and salaryMax are null, salaryCurrency and salaryPeriod are null too.
- Output whole integers for years and salary — no ranges-as-strings, no decimals, no units or symbols inside the numbers.`;

/**
 * The extraction output schema — every field `.nullable()` (the null-when-absent contract) with a
 * `.describe()`. `salaryPeriod` is a `z.enum(...)` over the {@link SalaryPeriod} members. Inferred type is
 * pinned to {@link JobEnrichment} by the compile-time tripwire below, so the schema, the DB columns (4b), and
 * the backfill (4d) cannot silently diverge.
 */
export const JobEnrichmentSchema = z.object({
  // Bounds + `.catch(null)` are part of the null-when-absent contract, not cosmetics. The bounds reject
  // semantic garbage (a role requiring "10000" years from "10,000+ employees") and keep values inside the DB
  // columns (yoe_* = smallint max 32767; salary_* = integer max 2,147,483,647). `.catch(null)` on EVERY field
  // is the key: a single out-of-range/out-of-enum/wrong-type value coerces to null ("absent") instead of
  // failing the WHOLE object — so one mis-inferred field never (a) discards the other valid fields, nor (b)
  // leaves the row un-stamped to be re-extracted + re-billed on every backfill run (the keyset loop re-fetches
  // un-stamped rows first). null-when-absent is exactly what a coerced-out value should read as. 60 is an
  // ample human-career ceiling for required years.
  yoeMin: z
    .number()
    .int()
    .min(0)
    .max(60)
    .nullable()
    .catch(null)
    .describe("Minimum years of experience the role requires (0-60); null if not stated or clearly inferrable."),
  yoeMax: z
    .number()
    .int()
    .min(0)
    .max(60)
    .nullable()
    .catch(null)
    .describe("Maximum years of experience the role requires (0-60); null if not stated (a one-sided band is fine)."),
  salaryMin: z
    .number()
    .int()
    .min(0)
    .max(2_147_483_647)
    .nullable()
    .catch(null)
    .describe("Base-pay floor as a whole number in salaryCurrency units; null if no pay is stated."),
  salaryMax: z
    .number()
    .int()
    .min(0)
    .max(2_147_483_647)
    .nullable()
    .catch(null)
    .describe("Base-pay ceiling as a whole number in salaryCurrency units; null if no pay is stated."),
  salaryCurrency: z
    .string()
    .nullable()
    .catch(null)
    .describe('ISO-4217 3-letter code (e.g. "USD"); null if no salary is stated or the currency is ambiguous.'),
  salaryPeriod: z
    .enum(SALARY_PERIODS)
    .nullable()
    .catch(null)
    .describe('Pay period of the salary range; null if not stated or not one of the five members (e.g. "annual").'),
});

// Compile-time tripwire: JobEnrichmentSchema must infer EXACTLY JobEnrichment (the DB column shape in
// @opusfinder/shared). Drift in either side fails `pnpm --filter @opusfinder/llm typecheck` NOW — before the
// db columns (4b) or the backfill (4d) silently disagree with the schema. (Mirrors cv-extract.ts's tripwire.)
type JobEnrichmentParsed = z.infer<typeof JobEnrichmentSchema>;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _jobEnrichmentSchemaMatchesType: Equal<JobEnrichmentParsed, JobEnrichment> = true;

// The prompt + schema + tripwire are the whole module (the cv-extract.ts shape — prompt/schema only). The
// SDK wiring (compose text + call generateObject) lives in the single consumer-side factory
// `makeJobEnrichmentExtractor` (../job-enrich-extractor.ts), which both the backfill and the eval reuse — so
// there is one production code path WITHOUT a pure-core-that-takes-a-call indirection (cf. embed()).
