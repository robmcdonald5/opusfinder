import type { Db } from "@opusfinder/db";
import {
  getDigestEmailPayload,
  recordDigestDeliveryOutcome,
  recordDigestSendFailure,
  recordDigestSent,
  type DigestDeliveryOutcome,
  type DigestEmailPayload,
} from "@opusfinder/db/repos";
import type { DigestDeliveryStatus } from "@opusfinder/db/schema";
import type { SendDigestResult } from "@opusfinder/email";

/**
 * The Phase-11 email-delivery tail of `digest-user`: ONE send step (payload read → allowlist-gated
 * Resend send → state write), a bounded delivery poll, and ONE record step. Split from ./digest so
 * the stub smoke (scripts/test-digest-email.ts) can drive the failure/skip/happy paths with a fake
 * `step` — the real function passes Inngest's step tools straight through.
 */

// Bounded delivery poll (locked decision: two polls max, NOT webhooks — no public endpoint until
// Phase 12). 2m catches the common fast delivery; the 10m tail catches delivery_delayed retries.
// An email still in flight after both simply stays 'sent' — never wrong, just less specific.
const DELIVERY_WAIT_0 = "2m";
const DELIVERY_WAIT_1 = "10m";

/** The `DigestDeps.email` seam — wired to @opusfinder/email by buildDigestDeps (./deps), stubbed by
 *  the smoke scripts. Lives here (not ./digest) beside its only consumer. */
export interface EmailSeam {
  send: (payload: DigestEmailPayload) => Promise<SendDigestResult>;
  lastEvent: (emailId: string) => Promise<string>;
}

/** The two step primitives this module uses — structural, so the stub smoke drives it with a fake
 *  step that records ids and runs `fn` inline, while Inngest's real tools pass straight through.
 *  Every step return here (SendDigestResult, string, void) is a JSON fixed-point, so Inngest's
 *  `Jsonify` memoization is the identity on them. */
export interface DeliveryStepTools {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleep(id: string, duration: string): Promise<void>;
}

/** Resend `last_event` values the poll should STOP on. Everything else (`queued`, `sent`,
 *  `delivery_delayed`, `scheduled`, …) is still in flight — keep polling / stay 'sent'. */
const TERMINAL_EVENTS = new Set([
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "failed",
]);

export function isTerminalEvent(lastEvent: string): boolean {
  return TERMINAL_EVENTS.has(lastEvent);
}

/**
 * Resend `last_event` → the digest's recorded outcome. PIPELINE policy, deliberately not transport:
 *  - `delivered` / `opened` / `clicked` → `delivered` (opens/clicks imply delivery).
 *  - `bounced` → `bounced` + hard-suppress. The poll's `last_event` carries no Permanent/Temporary
 *    split, so ANY poll-observed bounce records 'hard' — at one-recipient volume a bounce to your own
 *    address means something is broken and visible suppression is the feature; Phase 12's webhooks
 *    (which carry the subtype) refine this to a real soft/hard policy.
 *  - `complained` → `delivered` (it WAS delivered; the status union has no 'complained') + suppress
 *    WITHOUT touching bounce status (a complaint is not a bounce — `suppress.bounce` stays unset).
 *  - `failed` → `failed`. Anything else → stays `sent`.
 */
export function mapDeliveryEvent(lastEvent: string): DigestDeliveryOutcome {
  switch (lastEvent) {
    case "delivered":
    case "opened":
    case "clicked":
      return { status: "delivered" };
    case "bounced":
      return { status: "bounced", suppress: { bounce: "hard" } };
    case "complained":
      return { status: "delivered", suppress: {} };
    case "failed":
      return { status: "failed" };
    default:
      return { status: "sent" };
  }
}

/**
 * The post-persist step block of `digest-user`. At-least-once safe end-to-end: a step-retry replay
 * re-reads the same rows, renders byte-identical content, Resend's Idempotency-Key
 * (`digest/<digestId>`, 24h window) returns the SAME email id without a second send, and every
 * `record*` write is idempotent. The send step is deliberately NOT NonRetriableError-wrapped —
 * transient Resend 429/5xx SHOULD retry; only retry exhaustion reaches the catch, which terminalizes
 * `delivery_status='failed'` and rethrows (the orchestrator's fail-run discipline). A POLL-step
 * failure (e.g. a read key that 401s — observed at the live gate) instead fails the RUN while
 * `delivery_status` honestly stays `'sent'`: the send DID succeed, so writing 'failed' would claim a
 * non-delivery that never happened — run-failed + status-'sent' is intended state, not a
 * terminalize gap. Determinism
 * residual, accepted: the payload re-reads `jobs` per attempt, so a re-ingest BETWEEN retries could
 * alter it under the same key (409 → eventual 'failed') — dev ingestion is manual and retries are
 * minutes apart.
 */
export async function deliverDigestEmail(
  step: DeliveryStepTools,
  db: Db,
  email: EmailSeam,
  digestId: number,
): Promise<DigestDeliveryStatus | "skipped-allowlist" | "skipped-empty"> {
  let sent: SendDigestResult | { skipped: "empty" };
  try {
    sent = await step.run("send-email", async () => {
      const payload = await getDigestEmailPayload(db, digestId);
      // An existing digest always joins to ≥1 item; null means the row vanished — an invariant
      // break, same posture as the rerank-permutation check in ./digest.
      if (!payload) throw new Error(`digest: email payload missing for digest ${digestId}.`);
      // G1b: every item's job was lifecycle-closed between retrieval and send (an Arm A/B Worker tick
      // landing during the multi-hour synthesis wait — getDigestEmailPayload filters non-active jobs).
      // Send NOTHING (a closed job must never reach an inbox) and skip the poll. A clean no-send,
      // distinct from the null invariant break above; the orchestrator backs the user off the cadence.
      // Like the allowlist skip this is a SUCCESSFUL step result — once memoized it replays identically,
      // so the send-vs-skip branch never diverges across a retry (the per-attempt re-read residual noted
      // in this function's doc applies only when the step itself FAILS and the whole function retries).
      if (payload.items.length === 0) return { skipped: "empty" as const };
      const res = await email.send(payload);
      if ("emailId" in res) await recordDigestSent(db, digestId, res.emailId);
      return res;
    });
  } catch (err) {
    await step.run("record-send-failure", () => recordDigestSendFailure(db, digestId));
    throw err; // rethrow so Inngest records the failed run
  }
  if ("skipped" in sent) return sent.skipped === "empty" ? "skipped-empty" : "skipped-allowlist";
  const emailId = sent.emailId;

  // Bounded poll: sleep → poll; if still in flight, one slower second round. Poll steps are PURE
  // (return the last_event string); the single record step does the mapped writes.
  await step.sleep("delivery-wait-0", DELIVERY_WAIT_0);
  let lastEvent = await step.run("delivery-poll-0", () => email.lastEvent(emailId));
  if (!isTerminalEvent(lastEvent)) {
    await step.sleep("delivery-wait-1", DELIVERY_WAIT_1);
    lastEvent = await step.run("delivery-poll-1", () => email.lastEvent(emailId));
  }
  const outcome = mapDeliveryEvent(lastEvent);
  await step.run("record-delivery", () => recordDigestDeliveryOutcome(db, digestId, outcome));
  return outcome.status;
}
