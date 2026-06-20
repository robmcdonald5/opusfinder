// Public surface of @opusfinder/email — the Phase-11 digest email: a PURE deterministic render
// (escaped HTML + text part) and a thin Resend transport (idempotency-keyed send, last_event read).
// The send PERMIT is enforced upstream (the DB-native digest_approved_at gate), not here. Node/server
// runtime only — deny-listed from the scrapers Worker.
export { renderDigestEmail } from "./render";
export type { RenderedEmail } from "./render";
export { emailIdempotencyKey, getEmailLastEvent, sendDigestEmail, sendHealthAlert } from "./transport";
export type { SendDigestResult } from "./transport";
