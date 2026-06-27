// Public surface of @opusfinder/auth (node/server-only — never imported by the scrapers Worker).
export { createAuth } from "./auth";
export type { Auth } from "./auth";
export { createUserWithPreferences, getOrCreateUserByEmail, findUserIdByEmail } from "./service";
export type { CreateUserInput } from "./service";
