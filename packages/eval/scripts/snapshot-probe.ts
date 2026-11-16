/**
 * Probe a challenger's pinned host before a paid run (a few short texts: well under one cent). It
 * answers what the docs leave open:
 *  - does the pinned request work, at the expected width, with token usage reported;
 *  - is the same text embedded the same way twice (the host is deterministic);
 *  - does the host add the model's query/document prefix by itself. If the host already prefixed
 *    documents, a text sent with the prefix and one sent without would come back almost identical.
 *
 *   pnpm --filter @opusfinder/eval snapshot:probe -- --model qwen3-embedding-8b
 *
 * Prints numbers only (widths, tokens, cosines).
 */
import { runScript } from "@opusfinder/shared/script";

import { getFlag } from "../src/cli";
import { cosineSimilarity } from "../src/cosine";
import {
  challengerSpec,
  embedRequest,
  NEMOTRON_PREFIX,
  qwenQueryText,
} from "../src/embedders/challengers";
import { isSnapshotModelSlug } from "../src/embedders/snapshot-models";

const TEXTS = [
  "Registered Nurse, Medical-Surgical Unit\n\nProvides direct patient care on a 28-bed unit. Requires an active RN licence and BLS certification.",
  "Senior Backend Engineer\n\nDesign and operate distributed services in Go and PostgreSQL. Five years of experience with production systems.",
  "Warehouse Associate, Night Shift\n\nPick, pack and load orders. Must lift 50 lb and operate a pallet jack. Weekly pay.",
];

async function main(): Promise<void> {
  const slug = getFlag(process.argv.slice(2), "--model") ?? "";
  if (!isSnapshotModelSlug(slug) || slug === "voyage-4-large") {
    throw new Error("--model must be qwen3-embedding-8b or nemotron-3-embed-8b.");
  }
  const spec = challengerSpec(slug);
  const variant =
    slug === "nemotron-3-embed-8b"
      ? {
          name: `"${NEMOTRON_PREFIX.document}" prefix`,
          apply: (t: string) => `${NEMOTRON_PREFIX.document}${t}`,
        }
      : { name: "query instruction", apply: qwenQueryText };

  const plain = await embedRequest(spec, TEXTS);
  const again = await embedRequest(spec, TEXTS);
  const varied = await embedRequest(spec, TEXTS.map(variant.apply));
  const cos = (a: number[][], b: number[][]) =>
    a.map((v, i) => cosineSimilarity(v, b[i] as number[]).toFixed(6)).join(", ");
  const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)).toFixed(4);

  console.error(`${spec.id} on ${spec.host}`);
  console.error(`  width:                 ${plain.embeddings[0]?.length}`);
  console.error(`  vector norms:          ${plain.embeddings.map(norm).join(", ")}`);
  console.error(
    `  tokens (3 texts):      ${plain.totalTokens} plain, ${varied.totalTokens} with the ${variant.name}`,
  );
  console.error(`  same text, twice:      cosine ${cos(plain.embeddings, again.embeddings)}`);
  console.error(`  plain vs ${variant.name}: cosine ${cos(plain.embeddings, varied.embeddings)}`);
  console.error(
    `  text 1 vs text 2:      cosine ${cosineSimilarity(plain.embeddings[0] as number[], plain.embeddings[1] as number[]).toFixed(6)} (unrelated jobs, for scale)`,
  );
}

await runScript("SnapshotProbe", main);
