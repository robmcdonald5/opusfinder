import { neon } from "@neondatabase/serverless";
import { runScript } from "@opusfinder/shared/script";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

import { getDatabaseUrl } from "../src/env";

await runScript("Migration", async () => {
  const db = drizzle({ client: neon(getDatabaseUrl()) });
  console.log("Applying migrations from ./drizzle ...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");
});
