// Public surface of @opusfinder/email: a PURE deterministic render + a thin Resend transport. The
// send PERMIT is enforced upstream (the DB-native digest_approved_at gate), not here. Trusted server
// runtimes only: the scrapers Worker may not import it (guard:worker).
export { renderDigestEmail } from "./render";
export type { RenderedEmail } from "./render";
export { emailIdempotencyKey, getEmailLastEvent, sendDigestEmail, sendHealthAlert } from "./transport";
export type { EmailConfig, SendDigestResult } from "./transport";
