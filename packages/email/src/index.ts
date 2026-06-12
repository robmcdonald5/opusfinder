// Public surface of @opusfinder/email — the Phase-11 digest email: a PURE deterministic render
// (escaped HTML + text part) and a thin Resend transport (idempotency-keyed send, fail-closed
// allowlist, last_event read). Node/server runtime only — deny-listed from the scrapers Worker.
export { renderDigestEmail } from "./render";
export type { RenderedEmail } from "./render";
export { emailIdempotencyKey, getEmailLastEvent, sendDigestEmail } from "./transport";
export type { SendDigestResult } from "./transport";
