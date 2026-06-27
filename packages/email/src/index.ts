// Public surface of @opusfinder/email: a PURE deterministic render + a thin Resend transport. The
// send PERMIT is enforced upstream (the DB-native digest_approved_at gate), not here. Node/server only.
export { renderDigestEmail } from "./render";
export type { RenderedEmail } from "./render";
export { emailIdempotencyKey, getEmailLastEvent, sendDigestEmail, sendHealthAlert } from "./transport";
export type { SendDigestResult } from "./transport";
