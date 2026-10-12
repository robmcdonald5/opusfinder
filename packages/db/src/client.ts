import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * Drizzle client over Neon's HTTP driver: fetch-based HTTP only, no TCP sockets, so it works in Node
 * AND Cloudflare Workers. In Node pass process.env.DATABASE_URL; in a Worker pass env.DATABASE_URL.
 *
 * The transaction-capable neon-serverless client (`createAuthDb`) lives in the separate `./auth-client`
 * subpath ON PURPOSE — keeping it out of here means the scrapers Worker, which imports `createDb`, never
 * pulls neon-serverless/WebSocket into its bundle.
 */
export function createDb(connectionString: string) {
  return drizzle({ client: neonClient(connectionString), schema });
}

/**
 * neon() parses the string eagerly, and its parse error echoes the WHOLE string, password included. The
 * Worker passes its secret unvalidated, so this rethrows with only the shape and no `cause`.
 */
function neonClient(connectionString: string) {
  try {
    return neon(connectionString);
  } catch {
    const scheme = connectionString.match(/^[a-z][a-z0-9+.-]*(?=:\/\/)/i)?.[0];
    const found = scheme ? `found "${scheme}://"` : "no URL scheme found";
    throw new Error(
      `Database connection string is not a valid Postgres URL (length ${connectionString.length}, ` +
        `${found}). Expected postgresql://user:password@host/dbname, unquoted, with special ` +
        "password characters percent-encoded.",
    );
  }
}

export type Db = ReturnType<typeof createDb>;
export { schema };
