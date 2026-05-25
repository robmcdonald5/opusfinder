import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";
import { getDatabaseUrl } from "../src/env";

try {
  const db = drizzle({ client: neon(getDatabaseUrl()) });
  console.log("Applying migrations from ./drizzle ...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");
} catch (err) {
  console.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
