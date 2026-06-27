// Better Auth CLI entrypoint — used ONLY by `pnpm dlx @better-auth/cli generate` to introspect the
// schema. Constructs the SAME instance the app uses (createAuth) so the generated table/column shape
// matches production. Not imported by runtime code; `generate` reads model definitions without opening
// a DB connection, so constructing createAuthDb here is connection-free.
import { getDatabaseUrl } from "@opusfinder/db/env";
import { createAuthDb } from "@opusfinder/db/auth-client";

import { getAuthBaseURL, getAuthSecret } from "./src/env";
import { createAuth } from "./src/index";

export const auth = createAuth(createAuthDb(getDatabaseUrl()), {
  secret: getAuthSecret(),
  baseURL: getAuthBaseURL(),
});
