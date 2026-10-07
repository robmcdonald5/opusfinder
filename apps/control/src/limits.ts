/**
 * The cap on a request body, in BYTES (enforced by readBody() in index.ts). Its own runtime-neutral module
 * so the integration suite can import the real value: the Worker's main module may export only handlers
 * and classes.
 */
export const MAX_BODY_BYTES = 16 * 1024;
