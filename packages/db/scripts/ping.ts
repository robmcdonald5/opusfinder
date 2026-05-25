import { neon } from "@neondatabase/serverless";
import { getDatabaseUrl } from "../src/env";

try {
  const rows = await neon(getDatabaseUrl())`SELECT 1 AS ok`;
  console.log("Neon ping result:", rows); // expect: [ { ok: 1 } ]
} catch (err) {
  console.error(`Ping failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
