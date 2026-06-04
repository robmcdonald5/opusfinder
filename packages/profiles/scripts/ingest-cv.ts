import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { formatEmbedCost } from "@opusfinder/embeddings";
import { runScript } from "@opusfinder/shared/script";
import { mintUserId } from "@opusfinder/shared/userid";
import { createS3StorageClient } from "@opusfinder/storage";
import { getR2Config } from "@opusfinder/storage/env";

import { ingestCv } from "../src/index";
import { embed, structure, transcribe } from "./seams";

async function main(): Promise<void> {
  const pdfPath = process.argv[2]?.trim();
  const email = process.argv[3]?.trim();
  if (!pdfPath || !email) {
    console.error("Usage: pnpm ingest-cv <cv.pdf> <email>");
    process.exitCode = 1;
    return;
  }

  const db = createDb(getDatabaseUrl());
  const storage = createS3StorageClient(getR2Config());
  try {
    const bytes = await readFile(pdfPath);
    const userId = mintUserId(email);
    const result = await ingestCv(db, {
      userId,
      bytes,
      filename: basename(pdfPath),
      contentType: "application/pdf",
      transcribe,
      structure,
      embed,
      storage,
    });

    console.log(`user_id:  ${userId}`);
    console.log(`cv_file:  #${result.fileId} (${result.status})`);
    console.log(
      result.profileId !== undefined
        ? `profile:  #${result.profileId} (embedded, ${formatEmbedCost(result.embedTokens)})`
        : "profile:  not written",
    );
    if (result.warnings.length > 0) console.log(`warnings: ${result.warnings.join("; ")}`);
  } finally {
    storage.close();
  }
}

await runScript("IngestCv", main);
