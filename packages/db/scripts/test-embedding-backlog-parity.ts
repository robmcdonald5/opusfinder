import { PgDialect } from "drizzle-orm/pg-core";

import { runScript } from "@opusfinder/shared/script";

import { embeddableContentSql, jobEmbeddingText } from "../src/repos/embeddings";

/**
 * Stub smoke for the embedding-backlog PARITY invariant (F8 review finding E4) — JS-decidable, NO creds,
 * NO Postgres. The F8 embed-backlog-drain (and backfillJobEmbeddings) terminate WITHOUT a keyset cursor
 * only because jobsNeedingEmbedding's SQL predicate excludes exactly the rows jobEmbeddingText would render
 * empty: a contentless row is never selected AND would never reach embed() (Voyage 400s on ""). If those
 * two notions ever drift, an un-embeddable row gets re-selected every run and burns a Voyage request/day
 * (bounded by MAX_PAGES_PER_RUN, but wasteful) — or, the inverse, a row with content jobEmbeddingText
 * embeds but the SQL excludes is silently never embedded. This locks BOTH halves of that contract:
 *   - the JS empty-notion: jobEmbeddingText (→ composeEmbeddingText, parts.filter(trim().length>0)) is
 *     empty IFF neither title nor description has a non-whitespace char.
 *   - the SQL predicate: embeddableContentSql (the SINGLE SOURCE jobsNeedingEmbedding uses) tests BOTH
 *     title AND description_text for a non-whitespace char (`[^[:space:]]`) — the same OR-of-two notion.
 *
 *   pnpm --filter @opusfinder/db test:embed-parity
 */
const dialect = new PgDialect();

await runScript("test-embedding-backlog-parity", async () => {
  // 1) JS empty-notion: whitespace-only title + description → empty embed text (so the SQL must exclude it).
  assert(
    jobEmbeddingText({ title: "   ", descriptionText: "\t\n " }) === "",
    "whitespace-only title+description must produce empty embed text",
  );
  // 2) A non-whitespace char in EITHER field → non-empty (so the SQL must SELECT it). Mirrors the SQL OR.
  assert(
    jobEmbeddingText({ title: "Engineer", descriptionText: "   " }) !== "",
    "content in the title alone must produce non-empty embed text",
  );
  assert(
    jobEmbeddingText({ title: "  ", descriptionText: "Build things" }) !== "",
    "content in the description alone must produce non-empty embed text",
  );
  // 3) Genuinely empty strings → empty (the contentless row the drain must never re-select).
  assert(jobEmbeddingText({ title: "", descriptionText: "" }) === "", "empty title+description must be empty");

  // 4) SQL predicate parity: embeddableContentSql tests BOTH columns for a non-whitespace char — the same
  //    "title OR description has content" notion as the JS side. Rendered via PgDialect (no DB).
  const predicate = dialect.sqlToQuery(embeddableContentSql).sql;
  assert(
    /"jobs"\."title"\s*~\s*'\[\^\[:space:\]\]'/.test(predicate),
    `predicate must test jobs.title for a non-whitespace char — got: ${predicate}`,
  );
  assert(
    /"jobs"\."description_text"\s*~\s*'\[\^\[:space:\]\]'/.test(predicate),
    `predicate must test jobs.description_text for a non-whitespace char — got: ${predicate}`,
  );
  assert(/\bOR\b/i.test(predicate), `predicate must OR the two column tests — got: ${predicate}`);

  console.log(
    "test-embedding-backlog-parity OK — jobEmbeddingText empty IFF no non-whitespace char in title/desc; " +
      "embeddableContentSql tests both columns with [^[:space:]] OR — the F8 drain's cursorless termination " +
      "contract holds.",
  );
});

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
