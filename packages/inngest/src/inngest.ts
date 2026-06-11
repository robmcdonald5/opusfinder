import { EventSchemas, Inngest } from "inngest";

import type { DigestTrigger } from "@opusfinder/shared";

/**
 * The Inngest client + the typed event surface for the Phase-10 digest pipeline. Two events:
 *  - `digest/run.requested` — kicks the orchestrator (a manual CLI trigger now; a cadence cron in
 *    Phase 11). `userId` optionally scopes the run to a single user (the gate path).
 *  - `digest/user.requested` — one per recipient, fanned out by the orchestrator; drives the per-user
 *    digest function.
 *
 * `userId` rides the event as a plain string (events are JSON — the schema is compile-time only, so
 * the orchestrator re-validates it at runtime); the per-user function re-brands it to `UserId` for the
 * repo calls. In local dev the client runs in dev mode via `INNGEST_DEV=1` (no account, no signing
 * key); the Phase-12 production keys (`INNGEST_SIGNING_KEY`/`INNGEST_EVENT_KEY`) are read from the
 * environment by the SDK itself.
 */
export type DigestEvents = {
  "digest/run.requested": { data: { trigger: DigestTrigger; userId?: string } };
  "digest/user.requested": { data: { userId: string; digestRunId: number } };
};

export const inngest = new Inngest({
  id: "opusfinder",
  schemas: new EventSchemas().fromRecord<DigestEvents>(),
});
