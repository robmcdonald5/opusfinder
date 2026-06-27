import { sql } from "drizzle-orm";

import { createAuthDb } from "@opusfinder/db/auth-client";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { runScript } from "@opusfinder/shared/script";

import { getAuthBaseURL, getAuthSecret } from "../src/env";
import { createAuth } from "../src/index";

// Proves two things WITHOUT needing the auth tables:
//   1. The package wires together — better-auth imports, the Drizzle adapter binds, and `createAuth`
//      constructs with our config (generateId:"uuid", autoSignIn:false).
//   2. The auth DB driver is TRANSACTION-CAPABLE. `signUpEmail` needs an interactive transaction;
//      neon-http throws "No transactions support in neon-http driver", neon-serverless (`createAuthDb`)
//      succeeds. A `select 1` inside a transaction is the precise, table-free probe — it fails loudly
//      here if the wrong driver was wired.
// Run: pnpm --filter @opusfinder/auth test:auth   (needs DATABASE_URL + BETTER_AUTH_SECRET)
async function main(): Promise<void> {
  const authDb = createAuthDb(getDatabaseUrl());
  try {
    const auth = createAuth(authDb, { secret: getAuthSecret(), baseURL: getAuthBaseURL() });
    if (typeof auth.handler !== "function") throw new Error("createAuth produced no handler");
    console.log(`createAuth: constructed OK (baseURL ${getAuthBaseURL()})`);

    // An interactive transaction. Throws on neon-http; resolves on neon-serverless.
    const rows = await authDb.transaction(async (tx) => {
      const probeResult = await tx.execute(sql`select 1 as ok`);
      return probeResult.rows;
    });
    if (rows[0]?.ok !== 1) throw new Error(`unexpected probe result: ${JSON.stringify(rows)}`);

    console.log("auth-db transaction: OK — neon-serverless is transaction-capable (B1 resolved).");
    console.log("\nPASS: 9.5b auth seam + transactional driver verified.");
  } finally {
    // A neon-serverless Pool holds the socket open; close it or the process won't exit.
    await authDb.$client.end();
  }
}

await runScript("test-auth-db", main);
