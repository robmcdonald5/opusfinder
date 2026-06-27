import { findUserIdByEmail } from "@opusfinder/auth";
import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { runScript } from "@opusfinder/shared/script";
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
    // Resolve the EXISTING user by email (db-only lookup — restructure must not CREATE a user; a
    // missing user means there is nothing to re-structure).
    const userId = await findUserIdByEmail(db, email);
    if (!userId) {
      console.error("No user found for that email — nothing to re-structure.");
      process.exitCode = 1;
      return;
    }
    await restructureProfile(db, { structure, embed, storage }, userId);
    console.log(`Re-structured profile for ${userId}.`);
  } finally {
    storage.close();
  }
}

await runScript("ProfilesRestructure", main);
