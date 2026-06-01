import { neon } from "@neondatabase/serverless";
import { runScript } from "@opusfinder/shared/script";

import { getDatabaseUrl } from "../src/env";

await runScript("Ping", async () => {
  const rows = await neon(getDatabaseUrl())`SELECT 1 AS ok`;
  console.log("Neon ping result:", rows); // expect: [ { ok: 1 } ]
});
