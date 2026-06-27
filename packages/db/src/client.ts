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
  return drizzle({ client: neon(connectionString), schema });
}

export type Db = ReturnType<typeof createDb>;
export { schema };
