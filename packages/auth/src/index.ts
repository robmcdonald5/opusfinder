// Public surface of @opusfinder/auth (node/server-only — never imported by the scrapers Worker).
// The env readers live behind the `./env` subpath (they run loadPackageEnv at import), mirroring
// @opusfinder/storage. The service layer (createUserWithProfile / getOrCreateUserByEmail) lands in 9.5d.
export { createAuth } from "./auth";
export type { Auth } from "./auth";
