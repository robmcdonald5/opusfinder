import type { UserId } from "@opusfinder/shared";

/**
 * A deterministic, monotonically-ascending v4-shaped UUID for directly-seeded rows (bystanders,
 * lookup-only users). Postgres orders `uuid` bytewise, so `uid(1) < uid(2) < …` makes
 * `ORDER BY user.id` / keyset `gt(afterId)` assertions deterministic instead of riding on
 * `gen_random_uuid()` insertion order. The fixed `4` and `8` nibbles keep it a syntactically valid
 * v4 UUID so `uuid` columns accept it.
 */
export function uid(n: number): UserId {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as UserId;
}
