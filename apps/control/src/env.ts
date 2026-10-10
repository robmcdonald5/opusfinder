/**
 * The control Worker's bindings. Everything identity-related is a `wrangler secret` (set by the owner
 * at provisioning, see README) — never a `[vars]` entry — so no team domain, AUD tag, owner email or
 * service-token client id is ever committed to the repo.
 */
import type { InvoiceAi } from "./statements";

export interface Env {
  /** D1 `opusfinder-control`: state, change_log, proposal, ledger, statement. */
  DB: D1Database;
  /** Workers AI (wrangler `[ai]`): reads the amount on a forwarded invoice. Absent → the owner reads it. */
  AI?: InvoiceAi;
  /** The address the owner's invoice filter forwards to (wrangler `[vars]`); mail for any other is refused. */
  BILLING_ADDRESS?: string;
  /** `https://<team>.cloudflareaccess.com` — the Access issuer and the JWKS host. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's AUD tag (Zero Trust → Access → Applications → the Worker's app). */
  ACCESS_AUD?: string;
  /** Comma-separated human emails that map to the OWNER role. Anyone else Access lets in is refused. */
  OWNER_EMAILS?: string;
  /**
   * JSON map of Access service-token client id → { role, name }, e.g.
   * `{"<client-id>.access": {"role": "agent", "name": "observer"}}`. role ∈ agent | runtime.
   * A token Access accepts but this map doesn't list is refused (default deny).
   */
  SERVICE_TOKENS?: string;
}
