import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * Drizzle client over Neon's HTTP driver. Works in Node (now) AND Cloudflare
 * Workers (Phase 8): fetch-based HTTP only, no TCP sockets.
 *
 * In Node, pass process.env.DATABASE_URL; in a Worker, pass env.DATABASE_URL.
 */
export function createDb(connectionString: string) {
  return drizzle({ client: neon(connectionString), schema });
}

export type Db = ReturnType<typeof createDb>;
export { schema };
