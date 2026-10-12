/**
 * Full-report authorization for the health DATA route — extracted from +server.ts so the Bearer /
 * secure-default gate is unit-testable in isolation. True ONLY when HEALTH_PING_TOKEN is set AND the caller
 * presents it as an `Authorization: Bearer <token>` header — never a query param, since a URL lands in
 * request logs and monitor configs. When the token is UNSET, nobody is authorized for the full body (secure
 * default): the public URL leaks only `{ unhealthy }` until the owner deliberately sets the token.
 */
export function isAuthorized(request: Request): boolean {
  const expected = process.env.HEALTH_PING_TOKEN?.trim();
  if (!expected) return false; // unset → nobody is authorized for the full body (secure default)
  return request.headers.get("authorization") === `Bearer ${expected}`;
}
