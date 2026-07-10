/**
 * Full-report authorization for the health DATA route — extracted from +server.ts so the Bearer / ?token /
 * secure-default gate is unit-testable in isolation. True ONLY when HEALTH_PING_TOKEN is set AND the caller
 * presents it (Authorization: `Bearer <token>` header, or `?token=<token>` query param). When the token is
 * UNSET, nobody is authorized for the full body (secure default): the public URL leaks only `{ unhealthy }`
 * until the owner deliberately sets the token.
 */
export function isAuthorized(request: Request, url: URL): boolean {
  const expected = process.env.HEALTH_PING_TOKEN;
  if (!expected) return false; // unset → nobody is authorized for the full body (secure default)
  const bearer = request.headers.get("authorization");
  const presented = bearer?.startsWith("Bearer ") ? bearer.slice(7) : url.searchParams.get("token");
  return presented === expected;
}
