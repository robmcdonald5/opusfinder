// Deterministic user-id minting (UUIDv5 over email). Isolated in its own entry point
// (`@opusfinder/shared/userid`) because it imports `node:crypto` — the same discipline as
// `./env` (node:url): the package's main `index.ts` stays node-free so it can be bundled into
// the `nodejs_compat`-less scrapers Worker without pulling a `node:` builtin into the graph.
import { createHash } from "node:crypto";

import type { UserId } from "./index";

/**
 * Fixed UUID namespace for opusfinder user ids. The minted id is `UUIDv5(namespace, email)`.
 *
 * RETIRED from the live path in Phase 9.5: real identity now lives in the Better Auth `user` table
 * (a random `user.id`), and `ingest-cv` / `profiles-restructure` resolve a real id via
 * `getOrCreateUserByEmail` / `findUserByEmail` (@opusfinder/auth). `mintUserId` is kept ONLY as a
 * deterministic helper for the stub smoke (`test-ingest.ts`) and the golden test (`test-userid.ts`),
 * and as a potential backfill key for a §7a re-key migration — so this constant is preserved (a re-key
 * would need it), but it is no longer the source of any live user id, and email-derived ids are NOT
 * reintroduced on the live path (email is PII → reversible ids are a debt being paid down, not perpetuated).
 */
const OPUSFINDER_USER_NS = "dddeb344-c4fe-4ba0-9dd5-0d721702193c";

/**
 * Parse a canonical UUID string into its 16 raw bytes; throws if the result is not 16 bytes.
 * `Buffer.from(_, "hex")` SILENTLY truncates malformed/odd-length input (stops at the first
 * non-hex pair) rather than throwing — so without this guard a corrupted namespace constant would
 * quietly shift every minted id and orphan existing `user_profiles` rows.
 */
function uuidToBytes(uuid: string): Buffer {
  const bytes = Buffer.from(uuid.replace(/-/g, ""), "hex");
  if (bytes.length !== 16) {
    throw new Error(`uuidToBytes: ${JSON.stringify(uuid)} is not a 16-byte UUID`);
  }
  return bytes;
}

/** The namespace's 16 bytes, parsed once at module load — the constant never changes, so there is
 *  no need to re-parse it on every mint. */
const OPUSFINDER_USER_NS_BYTES = uuidToBytes(OPUSFINDER_USER_NS);

/** Format 16 bytes as a canonical lowercase UUID string (8-4-4-4-12). */
function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Mint a stable {@link UserId} from an email — a deterministic UUIDv5 (RFC 4122 §4.3) over the
 * fixed {@link OPUSFINDER_USER_NS} namespace and the normalized email. Idempotent: the same email
 * (case- and surrounding-whitespace-insensitive) always yields the same id, so re-ingesting a
 * user's CV upserts the one `user_profiles` row instead of forking a new identity.
 *
 * NOTE: normalization is `trim().toLowerCase().normalize("NFC")` only — provider-specific aliasing
 * (Gmail dots / `+tags`) is intentionally NOT canonicalized; treat `a.b@gmail` and `ab@gmail` as
 * distinct until real auth (Phase 12) resolves identity.
 */
export function mintUserId(email: string): UserId {
  // NFC so canonically-equivalent non-ASCII emails (a precomposed `é` vs `e` + combining accent)
  // hash to identical bytes; normalize LAST so the exact string fed to SHA-1 is the canonical form.
  const name = email.trim().toLowerCase().normalize("NFC");
  if (name.length === 0) {
    throw new Error("mintUserId: email is empty");
  }
  // SHA-1 over namespace bytes ++ UTF-8 name bytes; COPY the first 16 (a bare subarray would alias
  // the digest's backing memory and the version/variant writes below would mutate it in place).
  const hash = createHash("sha1").update(OPUSFINDER_USER_NS_BYTES).update(name, "utf8").digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5 (high nibble of byte 6)
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant (top two bits of byte 8)
  return bytesToUuid(bytes) as UserId;
}
