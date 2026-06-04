import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { runScript } from "@opusfinder/shared/script";
import { mintUserId } from "@opusfinder/shared/userid";
import { createS3StorageClient } from "@opusfinder/storage";
import { getR2Config } from "@opusfinder/storage/env";

import { restructureProfile } from "../src/index";
import { embed, structure } from "./seams";

async function main(): Promise<void> {
  const email = process.argv[2]?.trim();
  if (!email) {
    console.error("Usage: pnpm profiles:restructure <email>");
    process.exitCode = 1;
    return;
  }
  const db = createDb(getDatabaseUrl());
  const storage = createS3StorageClient(getR2Config());
  try {
    const userId = mintUserId(email);
    await restructureProfile(db, { structure, embed, storage }, userId);
    console.log(`Re-structured profile for ${userId}.`);
  } finally {
    storage.close();
  }
}

await runScript("ProfilesRestructure", main);
