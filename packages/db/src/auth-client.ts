import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

/**
 * Drizzle client over Neon's WebSocket (serverless) driver — TRANSACTION-CAPABLE, unlike the neon-http
 * `createDb`. Better Auth's `signUpEmail` wraps the `user`+`account` inserts in an interactive
 * transaction, which neon-http refuses ("No transactions support in neon-http driver", neon #4747) —
 * so `@opusfinder/auth`'s adapter MUST use this handle (Phase 9.5, decision B1).
 *
 * Lives in its OWN subpath (`@opusfinder/db/auth-client`), NOT in `client.ts`, so the scrapers Worker
 * — which imports only `createDb` from the package root — never pulls neon-serverless/WebSocket into
 * its bundle. Same node-only-behind-a-subpath discipline as the `./env` modules.
 *
 * Node 24 exposes a global `WebSocket`, which the neon driver auto-uses when
 * `neonConfig.webSocketConstructor` is unset — so no `ws` package is needed. A `Pool` keeps the
 * socket open, so a caller MUST close it via `authDb.$client.end()` when done, or the process hangs.
 */
export function createAuthDb(connectionString: string) {
  return drizzle({ client: new Pool({ connectionString }), schema });
}

export type AuthDb = ReturnType<typeof createAuthDb>;
