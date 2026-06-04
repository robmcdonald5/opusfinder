import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { embed } from "@opusfinder/embeddings";
import { runScript } from "@opusfinder/shared/script";
import { mintUserId } from "@opusfinder/shared/userid";

import { reembedProfile } from "../src/index";

// Re-embed from the stored structured JSON (no LLM, no storage), so this script imports embed
// directly rather than the llm-pulling ./seams.
async function main(): Promise<void> {
  const email = process.argv[2]?.trim();
  if (!email) {
    console.error("Usage: pnpm profiles:reembed <email>");
    process.exitCode = 1;
    return;
  }
  const db = createDb(getDatabaseUrl());
  const userId = mintUserId(email);
  await reembedProfile(db, embed, userId);
  console.log(`Re-embedded profile for ${userId}.`);
}

await runScript("ProfilesReembed", main);
