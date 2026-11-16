import { createDb, type Db } from "@opusfinder/db";
import { healthOptionsFromEnv } from "@opusfinder/db/health";
import { getDigestFanOutState, setDigestInstance } from "@opusfinder/db/repos";
import {
  buildDigestDeps,
  getHealthAlertCooldownH,
  type DigestDeps,
  type HealthCheckDeps,
  type PerUserEvent,
} from "@opusfinder/digest";
import { sendHealthAlert, type EmailConfig } from "@opusfinder/email";
import type { UserId } from "@opusfinder/shared";

import { readGate, type ControlBinding } from "./control";
import type { FanOutStore } from "./fan-out";

/** The orchestrator Workflow's parameters, all as the tick read them: the tick's UTC date, the stage's
 *  mode (for the ledger row; the send step reads the mode again) and the most user runs to start. */
export interface RunParams {
  tick: string;
  mode: "shadow" | "on";
  maxUsers: number;
}

/** The health-check Workflow's parameters: the checks' modes and thresholds and the alert cooldown, as the
 *  tick read them from the `alerts` gate (./control `healthVars`). */
export interface HealthParams {
  vars: Record<string, string>;
}

export interface Env {
  /** Neon connection string as the limited `digest_worker` role (a `wrangler secret`, set by
   *  `pnpm --filter @opusfinder/db run digest-role:setup`). */
  DATABASE_URL: string;
  /** OpenRouter key for the rerank and the synthesis batch (a `wrangler secret`). */
  OPENROUTER_API_KEY: string;
  /** Resend key that sends (a `wrangler secret`; a sending-only key is enough). */
  RESEND_API_KEY: string;
  /** Resend key that can READ an email's state, for the delivery poll (a `wrangler secret`; full access:
   *  a sending-only key gets 401 on the read). */
  RESEND_API_KEY_FULL: string;
  /** The verified sender address (a `wrangler secret`, so no address sits in the repo). */
  EMAIL_FROM: string;
  /** Where health alerts go (a `wrangler secret`). OPTIONAL until a health check enforces: an alert that
   *  is due without it fails loudly. */
  ALERT_TO?: string;
  /** The control plane: a service binding to the `opusfinder-control` Worker's `ControlRpc` entrypoint.
   *  The gate it serves is the only switch for this Worker's stages (./control.ts); unbound = off. */
  CONTROL?: ControlBinding;
  /** The orchestrator Workflow: one instance per daily tick. */
  DIGEST_RUN: Workflow<RunParams>;
  /** The per-user Workflow: one instance per due user per tick. */
  DIGEST_USER: Workflow<PerUserEvent["data"]>;
  /** The health-check Workflow: one instance per 2-hourly tick. */
  HEALTH_CHECK: Workflow<HealthParams>;
}

function emailConfig(env: Env): EmailConfig {
  return {
    apiKey: env.RESEND_API_KEY,
    apiKeyFull: env.RESEND_API_KEY_FULL,
    from: env.EMAIL_FROM,
    alertTo: env.ALERT_TO,
  };
}

/** The digest's production deps from this Worker's bindings. `enforceLifecycle` is the `close` policy as
 *  the control plane has it (./control `closeEnforced`); the orchestrator never closes a job. */
export function digestDeps(env: Env, enforceLifecycle = false): DigestDeps {
  return {
    ...buildDigestDeps({
      databaseUrl: env.DATABASE_URL,
      llm: { apiKey: env.OPENROUTER_API_KEY },
      email: emailConfig(env),
      enforceLifecycle,
    }),
    // Read at the send boundary, so a stage turned to logs only or off during the batch wait stops the
    // email. Only `on` lets an account's `email` setting through; an unreadable gate throws (a retry).
    logsOnly: async () => (await readGate(env.CONTROL, "digest")).mode !== "on",
  };
}

/** What the fan-out reads and writes per user, in `user_preferences`: the instance last started
 *  (`digest_instance_id`) and since when the user has been due. */
export function fanOutStore(db: Db): FanOutStore {
  return {
    state: (userIds) => getDigestFanOutState(db, userIds as UserId[]),
    record: (userId, instanceId) => setDigestInstance(db, userId as UserId, instanceId),
  };
}

/** The health check's deps from this Worker's bindings and the `alerts` gate's settings: every check's
 *  mode and threshold and the alert cooldown are the control plane's (./control `healthVars`). A check is
 *  reported and never emailed until its row says enforce. */
export function healthDeps(env: Env, vars: HealthParams["vars"]): HealthCheckDeps {
  const email = emailConfig(env);
  return {
    db: createDb(env.DATABASE_URL),
    healthOptions: healthOptionsFromEnv(vars),
    send: (subject, text) => sendHealthAlert(subject, text, email),
    cooldownH: getHealthAlertCooldownH(vars),
  };
}
