import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { createAuth, getOrCreateUserByEmail } from "@opusfinder/auth";
import { getAuthBaseURL, getAuthSecret } from "@opusfinder/auth/env";
import { createDb } from "@opusfinder/db";
import { createAuthDb } from "@opusfinder/db/auth-client";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { formatEmbedCost } from "@opusfinder/embeddings";
import { runScript } from "@opusfinder/shared/script";
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
  const authDb = createAuthDb(getDatabaseUrl());
  const auth = createAuth(authDb, { secret: getAuthSecret(), baseURL: getAuthBaseURL() });
  const storage = createS3StorageClient(getR2Config());
  try {
    const bytes = await readFile(pdfPath);
    // Resolve a REAL user.id — creates a verified user + default prefs on first sight, idempotent on
    // email (Phase 9.5; replaces the retired mintUserId placeholder). ingestCv's signature is unchanged.
    const { userId } = await getOrCreateUserByEmail(db, auth, email);
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
    // The neon-serverless Pool (auth) holds a socket open — close it or the process hangs.
    await authDb.$client.end();
  }
}

await runScript("IngestCv", main);
