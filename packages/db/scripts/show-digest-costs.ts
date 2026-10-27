import { parseArgs } from "node:util";

import { runScript } from "@opusfinder/shared/script";

import { createDb } from "../src/client";
import { getDatabaseUrl } from "../src/env";
import { listDigestCosts, summarizeDigestCosts, type StageCost } from "../src/repos/digest-costs";

/**
 * Per-digest LLM cost from `digests.counts`, newest first: the rerank judge's and the synthesis notes'
 * tokens (in = prompt tokens, cached included) and $, and the total, then the total and mean over the
 * digests that have a cost. `—` = the stage never ran for that digest; `n/a` = it ran but its counts carry
 * no number (rows from before cost tracking). Users print as an 8-character id prefix, nothing else.
 *
 *   pnpm db:digest-costs [--user <id or prefix>] [--since <YYYY-MM-DD or ISO time>] [--limit N]   (default 30)
 */
await runScript("show-digest-costs", async () => {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      user: { type: "string" },
      since: { type: "string" },
      limit: { type: "string" },
    },
  });

  if (values.user !== undefined && !/^[0-9a-f-]{1,36}$/i.test(values.user)) {
    throw new Error(`--user expects a user id or its leading characters, got "${values.user}"`);
  }
  let since: Date | undefined;
  if (values.since !== undefined) {
    since = new Date(values.since);
    if (!/^\d{4}-\d{2}-\d{2}/.test(values.since) || Number.isNaN(since.getTime())) {
      throw new Error(`--since expects YYYY-MM-DD or an ISO time, got "${values.since}"`);
    }
  }
  let limit = 30;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!/^\d+$/.test(values.limit) || limit <= 0) {
      throw new Error(`--limit expects a positive integer, got "${values.limit}"`);
    }
  }

  const db = createDb(getDatabaseUrl());
  const rows = await listDigestCosts(db, { userPrefix: values.user, since, limit });
  if (rows.length === 0) {
    console.log("(no digests rows)");
    return;
  }

  console.log(
    `${"digest".padEnd(8)} ${"created (UTC)".padEnd(16)} ${"user".padEnd(8)} ${"status".padEnd(9)} ` +
      `${"items".padStart(5)} ${"judge in/out".padStart(15)} ${"judge $".padStart(8)} ` +
      `${"notes in/out".padStart(15)} ${"notes $".padStart(8)} ${"total $".padStart(8)}`,
  );
  for (const r of rows) {
    console.log(
      `${`#${r.id}`.padEnd(8)} ${r.createdAt.toISOString().slice(0, 16).replace("T", " ")} ` +
        `${r.userPrefix.padEnd(8)} ${r.deliveryStatus.padEnd(9)} ${String(r.itemCount).padStart(5)} ` +
        `${tokens(r.judge).padStart(15)} ${stageUsd(r.judge).padStart(8)} ` +
        `${tokens(r.notes).padStart(15)} ${stageUsd(r.notes).padStart(8)} ${usd(r.totalUsd).padStart(8)}`,
    );
  }

  const s = summarizeDigestCosts(rows);
  const unpriced = s.digests - s.priced;
  console.log(
    s.meanUsd === null
      ? `\n${s.digests} digest(s), none with a recorded cost.`
      : `\n${s.digests} digest(s), ${s.priced} with a cost: total ${usd(s.totalUsd)}, mean ${usd(s.meanUsd)}` +
          (unpriced > 0 ? ` (${unpriced} n/a)` : "") +
          ".",
  );
});

function tokens(stage: StageCost | null): string {
  if (stage === null) return "—";
  if (stage.inputTokens === null || stage.outputTokens === null) return "n/a";
  return `${stage.inputTokens}/${stage.outputTokens}`;
}

function stageUsd(stage: StageCost | null): string {
  return stage === null ? "—" : usd(stage.costUsd);
}

function usd(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(4)}`;
}
