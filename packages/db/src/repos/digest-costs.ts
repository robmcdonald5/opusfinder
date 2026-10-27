/**
 * Read-only query behind `db:digest-costs`: what each digest's two paid stages (the rerank judge and the
 * synthesis notes) used and cost, from `digests.counts`. Reads only the `digests` table, so it keeps
 * working wherever the digest pipeline runs, as long as the counts keys stay the same.
 */
import { and, desc, gte, like, sql, type SQL } from "drizzle-orm";

import type { Db } from "../client";
import { digests, type DigestDeliveryStatus, type RunCounts } from "../schema";

/** One paid stage of a digest as its counts record it. */
export interface StageCost {
  /** Prompt tokens, cache reads and writes included; null on rows from before token tracking. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** What OpenRouter charged; null on rows from before cost tracking. */
  costUsd: number | null;
}

export interface DigestCost {
  id: number;
  createdAt: Date;
  /** The first 8 characters of the user id; the full id never leaves the query. */
  userPrefix: string;
  deliveryStatus: DigestDeliveryStatus;
  itemCount: number;
  /** Null when the digest never reached the rerank (nothing was retrieved). */
  judge: StageCost | null;
  /** Null when the digest never reached synthesis. */
  notes: StageCost | null;
  /** Judge plus notes; null when a stage that ran has no recorded cost, so a missing cost never reads as $0. */
  totalUsd: number | null;
}

export interface DigestCostFilter {
  /** A user id or its leading characters, as the report prints them. */
  userPrefix?: string;
  since?: Date;
  limit: number;
}

export interface DigestCostSummary {
  digests: number;
  /** Digests with a known total. */
  priced: number;
  /** Sum over the priced digests. */
  totalUsd: number;
  /** Mean over the priced digests; null when none is priced. */
  meanUsd: number | null;
}

/** Newest first. */
export async function listDigestCosts(db: Db, filter: DigestCostFilter): Promise<DigestCost[]> {
  const where: SQL[] = [];
  if (filter.userPrefix !== undefined) {
    where.push(like(sql`${digests.userId}::text`, `${filter.userPrefix.toLowerCase()}%`));
  }
  if (filter.since !== undefined) where.push(gte(digests.createdAt, filter.since));
  const rows = await db
    .select({
      id: digests.id,
      createdAt: digests.createdAt,
      userPrefix: sql<string>`left(${digests.userId}::text, 8)`,
      deliveryStatus: digests.deliveryStatus,
      itemCount: digests.itemCount,
      counts: digests.counts,
    })
    .from(digests)
    .where(and(...where))
    .orderBy(desc(digests.createdAt), desc(digests.id))
    .limit(filter.limit);
  return rows.map(({ counts, ...row }) => {
    // Every rerank path writes `reranked`, so a rerank* key means the judge ran. Synthesis ran when any
    // item survived it, or when its counts are there (an all-dead digest has 0 items but paid for notes).
    const judge = hasKeyWithPrefix(counts, "rerank") ? stageCost(counts, "rerank") : null;
    const notes =
      row.itemCount > 0 || hasKeyWithPrefix(counts, "synth")
        ? stageCost(counts, "synthesis")
        : null;
    const stages = [judge, notes].filter((s) => s !== null);
    const totalUsd = stages.some((s) => s.costUsd === null)
      ? null
      : stages.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
    return { ...row, judge, notes, totalUsd };
  });
}

export function summarizeDigestCosts(rows: DigestCost[]): DigestCostSummary {
  const priced = rows.flatMap((r) => (r.totalUsd === null ? [] : [r.totalUsd]));
  const totalUsd = priced.reduce((sum, usd) => sum + usd, 0);
  return {
    digests: rows.length,
    priced: priced.length,
    totalUsd,
    meanUsd: priced.length === 0 ? null : totalUsd / priced.length,
  };
}

/** The `<prefix>InputTokens` / `…OutputTokens` / `…CacheReadTokens` / `…CacheCreationTokens` / `…CostUsd` keys. */
function stageCost(counts: RunCounts, prefix: "rerank" | "synthesis"): StageCost {
  const input = count(counts, `${prefix}InputTokens`);
  return {
    inputTokens:
      input === null
        ? null
        : input +
          (count(counts, `${prefix}CacheReadTokens`) ?? 0) +
          (count(counts, `${prefix}CacheCreationTokens`) ?? 0),
    outputTokens: count(counts, `${prefix}OutputTokens`),
    costUsd: count(counts, `${prefix}CostUsd`),
  };
}

/** A finite number under `key`, else null: jsonb holds whatever was written, so absent and malformed read alike. */
function count(counts: RunCounts, key: string): number | null {
  const value: unknown = counts[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasKeyWithPrefix(counts: RunCounts, prefix: string): boolean {
  return Object.keys(counts).some((k) => k.startsWith(prefix));
}
