import type { RequestHandler } from "msw";

/**
 * Provider request handlers (Voyage embeddings, Anthropic Messages + Batches, Resend, HN Algolia, ATS
 * boards, R2/S3) are added here as the MSW-backed HTTP suites land (Phase 3). Empty for the Phase 0
 * pilot: the only integration tests that run without creds make no HTTP, and the setup's
 * `onUnhandledRequest: "error"` guarantees that stays true (an unhandled request fails the test loudly).
 */
export const handlers: RequestHandler[] = [];
