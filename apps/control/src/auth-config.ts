/**
 * Identity configuration, parsed from the Worker's secrets. RUNTIME-NEUTRAL (no Workers or Node globals),
 * so it is unit-tested in the node pool as well as compiled into the Worker.
 *
 * Parsed ONCE per isolate per distinct secret value (memoised on the raw strings): a malformed
 * SERVICE_TOKENS is reported once when the isolate first sees it, not on every request, and a request
 * pays nothing for re-parsing. A `wrangler secret put` deploys a new version (new isolates), and the memo
 * key is the raw values anyway, so a changed secret is never served from a stale parse.
 */

/** Audit labels (service-token names, binding labels): short, log-safe, no spaces or markup. */
export const AUDIT_NAME_RE = /^[A-Za-z0-9._:-]{1,64}$/;

// The issuer AND the JWKS host. Pinned to Access's own domain so a typo'd or hostile secret can't point
// key discovery at someone else's server.
const TEAM_DOMAIN_RE = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;

export interface ServiceToken {
  role: "agent" | "runtime";
  name: string;
}

export interface AuthConfig {
  teamDomain: string;
  aud: string;
  owners: ReadonlySet<string>;
  tokens: ReadonlyMap<string, ServiceToken>;
}

/** The identity-related secrets (see env.ts). */
export interface AuthSecrets {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  OWNER_EMAILS?: string;
  SERVICE_TOKENS?: string;
}

export function normalizeTeamDomain(raw: string | undefined): string | null {
  if (!raw) return null;
  let domain = raw.trim().toLowerCase().replace(/\/+$/, "");
  if (!domain.startsWith("https://")) domain = `https://${domain}`;
  return TEAM_DOMAIN_RE.test(domain) ? domain : null;
}

function parseServiceTokens(
  raw: string | undefined,
  log: (message: string) => void,
): Map<string, ServiceToken> {
  const out = new Map<string, ServiceToken>();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Shape only — the value holds client ids (see secrets-not-in-errors-or-logs).
    log(`SERVICE_TOKENS is not valid JSON (length ${raw.length}); no service token is accepted`);
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    log("SERVICE_TOKENS must be a JSON object; no service token is accepted");
    return out;
  }
  let skipped = 0;
  for (const [clientId, value] of Object.entries(parsed)) {
    const v = value as Partial<ServiceToken> | null;
    const ok =
      clientId.length > 0 &&
      typeof v === "object" &&
      v !== null &&
      (v.role === "agent" || v.role === "runtime") &&
      typeof v.name === "string" &&
      AUDIT_NAME_RE.test(v.name);
    if (ok) out.set(clientId, { role: v.role as ServiceToken["role"], name: v.name as string });
    else skipped++;
  }
  if (skipped > 0) log(`SERVICE_TOKENS: ignored ${skipped} malformed entr(y/ies)`);
  return out;
}

function parse(secrets: AuthSecrets, log: (message: string) => void): AuthConfig | null {
  const teamDomain = normalizeTeamDomain(secrets.ACCESS_TEAM_DOMAIN);
  const aud = secrets.ACCESS_AUD?.trim();
  if (!teamDomain || !aud) return null;
  const owners = new Set(
    (secrets.OWNER_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
  return { teamDomain, aud, owners, tokens: parseServiceTokens(secrets.SERVICE_TOKENS, log) };
}

let memo: { key: string; config: AuthConfig | null } | null = null;

/**
 * The parsed config, or null when ACCESS_TEAM_DOMAIN / ACCESS_AUD are missing or invalid (the caller
 * then refuses every request: fail closed). Memoised on the four raw values.
 */
export function authConfig(
  secrets: AuthSecrets,
  log: (message: string) => void = (m) => console.error(m),
): AuthConfig | null {
  const key = JSON.stringify([
    secrets.ACCESS_TEAM_DOMAIN ?? null,
    secrets.ACCESS_AUD ?? null,
    secrets.OWNER_EMAILS ?? null,
    secrets.SERVICE_TOKENS ?? null,
  ]);
  if (memo?.key !== key) memo = { key, config: parse(secrets, log) };
  return memo.config;
}
