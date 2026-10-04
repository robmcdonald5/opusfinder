import { parseArgs } from "node:util";

import {
  INHERIT,
  normalizeReason,
  parseTarget,
  parseValue,
  type PolicyView,
  type StageView,
} from "@opusfinder/control";

import { apiError, callApi, CtlError, type FetchLike } from "./client";
import { loadConfig, type ConfigDeps } from "./config";

/**
 * `pnpm ctl` — the agent-facing face of the control plane (§11, §12.1). Every command is one call to the
 * control Worker's JSON API with the agent's Access service token; the Worker (not this CLI) decides what
 * the agent may do. The CLI only pre-validates input against the same registry so typos fail fast, and
 * turns "needs owner approval" into a proposal so an unattended agent never dead-ends.
 *
 * Exit codes (stable, for scripts and agents):
 *   0  done (read, applied, or already so)        3  not applied — a proposal is waiting for the owner
 *   1  error (network, Access, API)               4  not applied — needs approval and no proposal was filed
 *   2  usage error
 */

export const EXIT = { ok: 0, error: 1, usage: 2, proposed: 3, notApplied: 4 } as const;

export interface CliDeps extends ConfigDeps {
  fetch: FetchLike;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Interactive terminal? Decides whether `set` asks before filing a proposal. */
  isTTY: boolean;
  prompt: (question: string) => Promise<string>;
}

const USAGE = `usage: pnpm ctl <command> [options]

  status [--json]                               what is on, what ran, what is waiting
  set <target> <value> --reason "<why>"         change a switch, knob or override
        [--propose | --no-propose] [--dry-run] [--json]
                                                if the change needs the owner: asks (terminal) or
                                                files a proposal (non-interactive / --propose)
  propose <target> <value> --reason "<why>" [--json]
  proposals [--all] [--json]                    open proposals (--all: every status)
  withdraw <id> [--json]                        take back your own proposal

targets: global | <stage> | <policy> | <entry>.<knob> | <stage>@<dim>=<value>
  e.g. ingest, close, health.board_fail_ratio, ingest.boardsPerTick, ingest@source=smartrecruiters
values:  off | shadow | on | enforce | a number | inherit (clears an override)
config:  ~/.config/opusfinder-agent/ctl.json {"url","clientId","clientSecret"}
         or OPUSFINDER_CTL_URL / OPUSFINDER_CTL_CLIENT_ID / OPUSFINDER_CTL_CLIENT_SECRET`;

class UsageError extends Error {}

interface Parsed {
  command: string;
  positionals: string[];
  reason?: string;
  json: boolean;
  all: boolean;
  propose: boolean;
  noPropose: boolean;
  dryRun: boolean;
}

function parse(argv: string[]): Parsed {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        reason: { type: "string", short: "r" },
        json: { type: "boolean" },
        all: { type: "boolean" },
        propose: { type: "boolean" },
        "no-propose": { type: "boolean" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const [command = "help", ...positionals] = parsed.positionals;
  const v = parsed.values;
  if (v.propose && v["no-propose"])
    throw new UsageError("--propose and --no-propose are mutually exclusive");
  return {
    command: v.help ? "help" : command,
    positionals,
    reason: v.reason,
    json: v.json ?? false,
    all: v.all ?? false,
    propose: v.propose ?? false,
    noPropose: v["no-propose"] ?? false,
    dryRun: v["dry-run"] ?? false,
  };
}

/** Validate target/value/reason locally with the same registry the Worker uses (fast, offline typo check). */
function changeArgs(p: Parsed): { target: string; value: string; reason: string } {
  const [target, value, ...extra] = p.positionals;
  if (!target || value === undefined || extra.length > 0) {
    throw new UsageError(`${p.command} takes exactly <target> <value>`);
  }
  const t = parseTarget(target);
  if (!t.ok) throw new UsageError(t.error);
  const v = parseValue(t.value, value);
  if (!v.ok) throw new UsageError(v.error);
  const r = normalizeReason(p.reason);
  if (!r.ok) throw new UsageError(`${r.error} (--reason "<why>")`);
  return { target, value: v.value ?? INHERIT, reason: r.value };
}

// ---------------------------------------------------------------- human output

type Json = Record<string, unknown>;

interface Proposal {
  id: number;
  target: string;
  from_value: string | null;
  to_value: string | null;
  reason: string;
  status: string;
  proposer: string;
  expires_at: string;
  /** Only on /v1/status's open proposals: the target moved since filing, so approve would refuse it. */
  stale?: boolean;
  current?: string | null;
}

const short = (iso: unknown) =>
  typeof iso === "string" ? `${iso.slice(0, 16).replace("T", " ")}Z` : "-";
const val = (v: string | null | undefined) => v ?? INHERIT;

function pad(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows
    .map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  "))
    .join("\n");
}

function proposalLine(p: Proposal): string {
  const stale = p.stale ? ` STALE (now ${val(p.current)}; re-propose)` : "";
  return `#${p.id} ${p.target}: ${val(p.from_value)} → ${val(p.to_value)} by ${p.proposer} [${p.status}]${stale} (expires ${short(p.expires_at)}) — ${p.reason}`;
}

function formatStatus(s: Json): string {
  const stages = (s.stages ?? []) as (StageView & { lastRun: Json | null })[];
  const policies = (s.policies ?? []) as PolicyView[];
  const caller = s.caller as { role: string; name: string };
  const global = s.global as { desired: string };
  const out: string[] = [];
  out.push(`opusfinder control — ${short(s.generatedAt)} (you: ${caller.role}:${caller.name})`);
  out.push(
    `master switch: ${global.desired}${global.desired === "off" ? " (everything is capped at off)" : ""}`,
    "",
  );
  out.push(
    pad([
      ["STAGE", "DESIRED", "EFFECTIVE", "LAST RUN"],
      ...stages.map((st) => [
        st.id,
        st.desired,
        st.effective + (st.cappedBy ? ` (capped: ${st.cappedBy})` : ""),
        st.lastRun ? `${String(st.lastRun.outcome)} ${short(st.lastRun.started_at)}` : "-",
      ]),
    ]),
  );
  const overrides = stages.flatMap((st) => st.overrides);
  if (overrides.length > 0)
    out.push("", `overrides: ${overrides.map((o) => `${o.target}=${o.override}`).join(", ")}`);
  const knobs = [...stages.flatMap((st) => st.knobs), ...policies.flatMap((p) => p.knobs)].filter(
    (k) => k.source !== "default",
  );
  if (knobs.length > 0)
    out.push(`knobs (non-default): ${knobs.map((k) => `${k.target}=${k.value}`).join(", ")}`);
  out.push(
    "",
    pad([
      ["POLICY", "DESIRED", "EFFECTIVE", "AGENT"],
      ...policies.map((p) => [
        p.id,
        p.desired,
        p.effective,
        p.agent === "approval" ? "approval" : "safe-direction",
      ]),
    ]),
  );
  const open = (s.openProposals ?? []) as Proposal[];
  out.push("", `open proposals: ${open.length}`, ...open.map((p) => `  ${proposalLine(p)}`));
  const changes = ((s.recentChanges ?? []) as Json[]).slice(0, 8);
  out.push(
    "",
    "recent changes:",
    ...changes.map(
      (c) =>
        `  ${short(c.at)} ${String(c.target)}: ${val(c.from_value as string | null)} → ${val(
          c.to_value as string | null,
        )} by ${String(c.actor_role)}:${String(c.actor_name)} (${String(c.channel)}) — ${String(c.reason)}`,
    ),
  );
  return out.join("\n");
}

// ---------------------------------------------------------------- commands

type Call = (method: "GET" | "POST", path: string, body?: unknown) => ReturnType<typeof callApi>;

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  let p: Parsed;
  try {
    p = parse(argv);
  } catch (err) {
    deps.stderr(`${(err as Error).message}\n\n${USAGE}`);
    return EXIT.usage;
  }
  if (p.command === "help") {
    deps.stdout(USAGE);
    return EXIT.ok;
  }

  try {
    // Validate arguments before touching config, so usage errors are instant and offline.
    const run = command(p, deps);
    const cfg = loadConfig(deps);
    if (!cfg.ok) {
      deps.stderr(`config: ${cfg.error}`);
      return EXIT.error;
    }
    for (const w of cfg.warnings) deps.stderr(`warning: ${w}`);
    return await run((method, path, body) => callApi(cfg.config, deps.fetch, method, path, body));
  } catch (err) {
    if (err instanceof UsageError) {
      deps.stderr(`${err.message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    if (err instanceof CtlError) {
      deps.stderr(`error${err.code ? ` (${err.code})` : ""}: ${err.message}`);
      if (p.json && err.body !== undefined) deps.stdout(JSON.stringify(err.body, null, 2));
      return EXIT.error;
    }
    throw err;
  }
}

/** Parse a command into a runner (throws UsageError up front, before any config or network). */
function command(p: Parsed, deps: CliDeps): (call: Call) => Promise<number> {
  const emit = (json: unknown, human: string) =>
    deps.stdout(p.json ? JSON.stringify(json, null, 2) : human);

  switch (p.command) {
    case "status":
      if (p.positionals.length > 0) throw new UsageError("status takes no arguments");
      return async (call) => {
        const res = await call("GET", "/v1/status");
        if (res.status !== 200) throw apiError(res);
        emit(res.body, formatStatus(res.body as Json));
        return EXIT.ok;
      };

    case "proposals":
      if (p.positionals.length > 0) throw new UsageError("proposals takes no arguments");
      return async (call) => {
        const res = await call("GET", `/v1/proposals${p.all ? "?status=all" : ""}`);
        if (res.status !== 200) throw apiError(res);
        const list = (res.body as { proposals: Proposal[] }).proposals;
        emit(res.body, list.length === 0 ? "no proposals" : list.map(proposalLine).join("\n"));
        return EXIT.ok;
      };

    case "withdraw": {
      const [raw, ...extra] = p.positionals;
      const id = Number(raw?.replace(/^#/, ""));
      if (!raw || extra.length > 0 || !Number.isSafeInteger(id) || id <= 0) {
        throw new UsageError("withdraw takes one proposal id");
      }
      return async (call) => {
        const res = await call("POST", `/v1/proposals/${id}/withdraw`, {});
        if (res.status !== 200) throw apiError(res);
        emit(res.body, `withdrew proposal #${id}`);
        return EXIT.ok;
      };
    }

    case "propose": {
      const args = changeArgs(p);
      return async (call) => {
        const res = await call("POST", "/v1/proposals", args);
        if (res.status !== 200 && res.status !== 201) throw apiError(res);
        const { proposal, duplicate } = res.body as { proposal: Proposal; duplicate: boolean };
        emit(
          res.body,
          `${duplicate ? "already proposed" : "filed proposal"} #${proposal.id}: ${proposalLine(proposal)}`,
        );
        return EXIT.proposed;
      };
    }

    case "set": {
      const args = changeArgs(p);
      // Unattended (no terminal) or --propose: file the proposal in the same call. A terminal asks first.
      const autoPropose = p.propose || (!deps.isTTY && !p.noPropose);
      return async (call) => {
        const res = await call("POST", "/v1/changes", {
          ...args,
          ...(p.dryRun ? { dryRun: true } : {}),
          ...(autoPropose ? { proposeIfNeeded: true } : {}),
        });
        const b = res.body as Json & { result?: string };
        const fromTo = `${args.target} ${val(b.from as string | null)} → ${val(b.to as string | null)}`;
        if (res.status === 200 && b.result === "applied") {
          emit(b, `applied: ${fromTo} (change #${String(b.changeId)})`);
          return EXIT.ok;
        }
        if (res.status === 200 && b.result === "noop") {
          emit(b, `no change: ${args.target} is already ${args.value}`);
          return EXIT.ok;
        }
        if (res.status === 200 && b.result === "dry_run") {
          const d = b.decision as { outcome: string; rule: string };
          emit(b, `dry run: ${fromTo}: ${d.outcome} (${d.rule})`);
          return EXIT.ok;
        }
        if (res.status === 202 && b.result === "proposed") {
          const { proposal, duplicate } = b as unknown as {
            proposal: Proposal;
            duplicate: boolean;
          };
          emit(
            b,
            `needs owner approval: ${duplicate ? "already proposed as" : "created proposal"} #${proposal.id} ` +
              `(${args.target} → ${args.value}); the owner approves it on the control page`,
          );
          return EXIT.proposed;
        }
        const err = apiError(res);
        if (err.code !== "needs_approval") throw err;
        if (p.noPropose || !deps.isTTY) {
          emit(b, `not applied: ${err.message}`);
          return EXIT.notApplied;
        }
        const answer = await deps.prompt(`${err.message}.\nFile a proposal for the owner? [y/N] `);
        if (!/^y(es)?$/i.test(answer.trim())) {
          deps.stdout("not applied; no proposal filed");
          return EXIT.notApplied;
        }
        const filed = await call("POST", "/v1/proposals", args);
        if (filed.status !== 200 && filed.status !== 201) throw apiError(filed);
        const { proposal, duplicate } = filed.body as { proposal: Proposal; duplicate: boolean };
        emit(
          filed.body,
          `${duplicate ? "already proposed as" : "created proposal"} #${proposal.id}; the owner approves it on the control page`,
        );
        return EXIT.proposed;
      };
    }

    default:
      throw new UsageError(`unknown command "${p.command}"`);
  }
}
