import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POLICY_IDS, STAGE_IDS, policyDef } from "@opusfinder/control";
import { ORIGIN, startControl, type ControlHarness } from "@test/control/harness";

// The owner panel: an overview, then one page per section, all rendered from the same reads the API
// returns. Phone-friendly, script-free, every dynamic string escaped (agent-written reasons and
// runtime-written run details are untrusted), form posts same-origin only, and read-only for agents.

let h: ControlHarness;
beforeAll(async () => {
  h = await startControl();
}, 60_000);
afterAll(async () => {
  await h?.dispose();
});
beforeEach(async () => {
  await h.reset();
});

const PAGES = [
  "/",
  "/approvals",
  "/stages",
  "/stages/ingest",
  "/health",
  "/runs",
  "/cost",
  "/activity",
  "/proposals",
];

async function page(path: string, as: "owner" | "agent" = "owner"): Promise<string> {
  const res = await h.request(path, { as });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/text\/html/);
  return res.text();
}

async function stateValue(key: string): Promise<string | null> {
  const row = await h.db
    .prepare("SELECT value FROM state WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function fileProposal(target: string, value: string, reason = "r"): Promise<number> {
  const res = await h.request("/v1/proposals", { as: "agent", json: { target, value, reason } });
  return ((await res.json()) as { proposal: { id: number } }).proposal.id;
}

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

async function recordRun(
  run: Record<string, unknown>,
  as: "runtime" | "other-runtime" = "runtime",
): Promise<void> {
  const res = await h.request("/v1/runs", { as, json: run });
  expect(res.status).toBe(201);
}

describe("every page", () => {
  it.each(PAGES)(
    "%s renders for the owner and an agent, phone-friendly and script-free",
    async (path) => {
      for (const as of ["owner", "agent"] as const) {
        const html = await page(path, as);
        expect(html).toContain(
          '<meta name="viewport" content="width=device-width, initial-scale=1">',
        );
        expect(html).not.toMatch(/<script/i);
        expect(html).toContain('href="/"');
      }
    },
  );

  it.each(PAGES)("%s is read-only for an agent: no POST forms", async (path) => {
    await fileProposal("embed", "on");
    const html = await page(path, "agent");
    expect(html).toContain("read-only here");
    expect(html).not.toContain('method="post"');
  });

  it("marks the current section in the nav", async () => {
    expect(await page("/")).toContain('<a href="/" aria-current="page">');
    expect(await page("/health")).toContain('<a href="/health" aria-current="page">');
    expect(await page("/stages/ingest")).toContain('<a href="/stages" aria-current="page">');
    // Runs and Changes are two tabs of one Log section: either marks the Log item.
    expect(await page("/activity")).toContain('<a href="/runs" aria-current="page">');
  });

  it("sets the hardening headers", async () => {
    const res = await h.request("/stages", { as: "owner" });
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("uses a referrer policy that keeps the page's own form POSTs same-origin", async () => {
    // Regression (2026-10-07, first live use): with "no-referrer" a real browser sends `Origin: null` on
    // the page's form POSTs (Fetch spec), so the CSRF guard refused the owner's own Approve/Reject with
    // 403 cross_origin. The tests build requests with an explicit Origin, so only the header pins this.
    const res = await h.request("/", { as: "owner" });
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("shows only fixed flash messages (no reflected query text)", async () => {
    expect(await page("/stages?done=<b>pwned</b>")).not.toContain("pwned");
    expect(await page("/stages?done=applied")).toContain("Change applied.");
  });

  it("warns on every page while the master switch is off", async () => {
    await h.request("/v1/changes", {
      as: "owner",
      json: { target: "global", value: "off", reason: "drill" },
    });
    for (const path of PAGES) expect(await page(path)).toContain("The master switch is off");
  });

  it("answers an unknown stage page with a readable 404", async () => {
    const res = await h.request("/stages/nope", { as: "owner" });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("unknown_stage");
  });
});

describe("overview", () => {
  it("is a list of what needs the owner plus a tile per area, each linking to its page", async () => {
    const html = await page("/");
    for (const path of ["/stages", "/runs", "/cost", "/health"]) {
      expect(html).toContain(`<a class="stat" href="${path}">`);
    }
    expect(html).not.toContain('method="post"');
  });

  it("lists only what needs the owner, and puts live numbers on the tiles", async () => {
    let html = await page("/");
    expect(html).toContain("Nothing needs you right now.");
    expect(html).toContain("0 failed");

    await fileProposal("embed", "on");
    await recordRun({ stage: "ingest", outcome: "error", startedAt: hoursAgo(1), detail: "boom" });
    html = await page("/");
    expect(html).not.toContain("Nothing needs you right now.");
    expect(html).toContain('<a href="/approvals">1 proposal waiting</a>');
    expect(html).toContain(
      'href="/runs?stage=ingest&amp;outcome=error">Ingest job boards: 1 failed run</a>',
    );
    expect(html).toContain('<span class="bad">1 failed</span>');
    expect(html).toContain("8 checks: 8 logs only");
  });

  it("shows spend against the target as a meter, and says all clear when nothing needs the owner", async () => {
    const html = await page("/");
    expect(html).toContain('class="meter" role="img" aria-label="0% of the limit"');
    expect(html).toContain('<p class="empty good">');
  });

  it("flags an overdue stage", async () => {
    // ingest expects a run every 2 h with 1 h grace: a last run 4 h ago is overdue.
    await recordRun({ stage: "ingest", outcome: "ok", startedAt: hoursAgo(4) });
    expect(await page("/")).toContain('<a href="/stages/ingest">Ingest job boards</a> is overdue');
  });
});

describe("approvals", () => {
  it("escapes agent-written text", async () => {
    await fileProposal("embed", "on", `<script>alert(1)</script> "quoted" & 'single'`);
    const html = await page("/approvals");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot; &amp; &#39;single&#39;",
    );
  });

  it("names a proposal's target as people say it, linked to where it lives, the address on hover", async () => {
    await fileProposal("ingest.boardsPerTick", "400");
    await fileProposal("health.board_fail_ratio", "enforce");
    const html = await page("/approvals");
    expect(html).toContain(
      '<a href="/stages/ingest" title="ingest.boardsPerTick">ingest › Boards per tick</a>',
    );
    expect(html).toContain('<a href="/health" title="health.board_fail_ratio">Board failures</a>');
    await fileProposal("ingest@source=workable", "off");
    expect(await page("/approvals")).toContain(
      '<a href="/stages/ingest" title="ingest@source=workable">ingest › workable</a>',
    );
  });

  it("shows who acted short, with the full identity on hover", async () => {
    await fileProposal("embed", "on", "drain");
    expect(await page("/approvals")).toContain(
      '<span title="agent:observer">agent observer</span>',
    );
  });

  it("approves and rejects from the page and lands back on it", async () => {
    const a = await fileProposal("embed", "on");
    const b = await fileProposal("digest", "shadow");
    const html = await page("/approvals");
    expect(html).toContain(`action="/ui/proposals/${a}/approve"`);
    expect(html).toContain(`formaction="/ui/proposals/${a}/reject"`);

    const ok = await h.request(`/ui/proposals/${a}/approve`, { as: "owner", form: {} });
    expect(ok.headers.get("location")).toBe("/approvals?done=approved");
    expect(await stateValue("embed")).toBe("on");
    const decided = await h.db.prepare("SELECT status FROM proposal WHERE id = ?").bind(a).first();
    expect(decided).toEqual({ status: "approved" });
    const no = await h.request(`/ui/proposals/${b}/reject`, { as: "owner", form: {} });
    expect(no.headers.get("location")).toBe("/approvals?done=rejected");
    expect(await stateValue("digest")).toBe("off");
  });

  it("shows a stale proposal as stale (reject only), and a stale approve as a flash, not an error", async () => {
    const id = await fileProposal("embed", "on", "drain");
    await h.request("/v1/changes", {
      as: "owner",
      json: { target: "embed", value: "shadow", reason: "count first" },
    });

    const html = await page("/approvals");
    expect(html).toContain("Stale:");
    expect(html).not.toContain(`action="/ui/proposals/${id}/approve"`);
    expect(html).toContain(`action="/ui/proposals/${id}/reject"`);

    // A form posted before the page refreshed still lands safely: nothing applied, a clear flash.
    const ok = await h.request(`/ui/proposals/${id}/approve`, { as: "owner", form: { note: "" } });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/approvals?done=stale");
    expect(await stateValue("embed")).toBe("shadow");
    const after = await page("/approvals?done=stale");
    expect(after).toContain("That proposal was stale");
    expect(after).toContain("Recently closed (1)");
    expect(after).toContain('class="mode m-stale">stale</span>');
  });
});

describe("stages", () => {
  it("lists every stage with a link to its page, and the lifecycle policies", async () => {
    const html = await page("/stages");
    for (const id of STAGE_IDS) expect(html).toContain(`href="/stages/${id}"`);
    for (const id of POLICY_IDS) {
      const anchor = `id="policy-${id}"`;
      if ((policyDef(id).readBy as readonly string[]).includes("alerts"))
        expect(html).not.toContain(anchor);
      else expect(html).toContain(anchor);
    }
  });

  it("edits each switch and setting in place, with Confirm and Cancel", async () => {
    const html = await page("/stages");
    expect(html).toContain(
      '<form class="sw" method="post" action="/ui/change" autocomplete="off"><select name="value" aria-label="Master switch">',
    );
    expect(html).toContain(
      'aria-label="Confirm the change to Master switch">Confirm</button><button type="reset" class="go">Cancel</button>',
    );
    expect(html).toContain('name="value" type="number"');
    for (const path of ["/stages", "/stages/ingest", "/health"])
      expect(await page(path, "agent")).not.toContain('class="sw"');
  });

  it("puts a switch's settings on their own rows under it, each named on the left", async () => {
    const stages = await page("/stages");
    const stale = stages.slice(stages.indexOf('id="policy-stale_sweep"'));
    const nest = stale.slice(stale.indexOf('<ul class="rows nest">'), stale.indexOf("</ul>"));
    expect(nest).toContain('<strong title="stale_sweep.ttlDays">Close when unseen for</strong>');
    expect(nest).toContain('aria-label="Close when unseen for"');
    const health = await page("/health");
    expect(health).toContain('<ul class="rows nest">');
    expect(health).toContain(">Alert cooldown</strong>");
  });

  it("offers each switch only its own modes", async () => {
    const html = await page("/stages/ingest");
    // ingest is off|on: its mode dropdown has no shadow option.
    const form = html.slice(html.indexOf('<select name="value" aria-label="Ingest job boards">'));
    const select = form.slice(0, form.indexOf("</select>"));
    expect(select).toContain('<option value="off">off</option>');
    expect(select).toContain('<option value="on" selected>on</option>');
    expect(select).not.toContain("shadow");
  });

  it("puts a stage's knobs, slices, policies, checks, runs and changes on its page", async () => {
    await recordRun({
      stage: "ingest",
      outcome: "ok",
      startedAt: hoursAgo(1),
      durationMs: 250_000,
      detail: "208/208 boards · 2 failed",
    });
    await h.request("/v1/changes", {
      as: "owner",
      json: { target: "ingest@source=workable", value: "off", reason: "429 storm" },
    });
    const html = await page("/stages/ingest");
    expect(html).toContain('title="ingest.boardsPerTick">Boards per tick</strong>');
    expect(html).toContain('name="target" value="ingest.boardsPerTick"');
    expect(html).toContain('type="number"');
    // Every source is its own row, set from its own dropdown: follow the stage, or off.
    expect(html).toContain(
      '<select name="value" aria-label="Ingest job boards for smartrecruiters"><option value="inherit" selected>follows stage</option><option value="off">off</option></select>',
    );
    expect(html).toContain(
      '<select name="value" aria-label="Ingest job boards for workable"><option value="inherit">follows stage</option><option value="off" selected>off</option></select>',
    );
    // A slice with no override reads "follows stage", not the stored value "inherit".
    expect(html).toContain(
      '<span class="mode m-inherit">follows stage</span> → <span class="mode m-off">off</span>',
    );
    expect(html).toContain('href="/stages#policy-close"');
    expect(html).toContain("health check watching it");
    expect(html).toContain("208/208 boards · 2 failed");
    expect(html).toContain("4 min 10 s");
    expect(html).toContain("429 storm");
    expect(html).toContain('href="/runs?stage=ingest"');
  });

  it("says plainly how a stage is wired to its switch", async () => {
    expect(await page("/stages/ingest")).toContain("Logs only: the runtime reads this switch");
    expect(await page("/stages/embed")).toContain("Not wired: the runtime ignores this switch");
    const stages = await page("/stages");
    expect(stages).toContain("<th>Wiring</th>");
    // Wiring wears the same dot-and-word indicator as a mode.
    expect(stages).toMatch(/<span class="mode w-shadow" title="[^"]*">logs only<\/span>/);
  });

  it("says what each mode does", async () => {
    // The middle mode reads "logs only" everywhere; a policy's top mode reads "on", a check's "emails you".
    const health = await page("/health");
    expect(health).toContain('<option value="shadow" selected>logs only</option>');
    expect(health).toContain('<option value="enforce">emails you</option>');
    expect(await page("/health", "agent")).toContain(
      '<span class="mode m-shadow">logs only</span>',
    );
    const stages = await page("/stages");
    expect(stages).toContain('<option value="shadow" selected>logs only</option>');
    expect(stages).toContain('<option value="enforce" selected>on</option>');
    const agentStages = await page("/stages", "agent");
    expect(agentStages).toContain('<span class="mode m-shadow">logs only</span>');
    expect(agentStages).toContain('<span class="mode m-enforce">on</span>');
  });

  it("calls a run due within its grace late", async () => {
    // ingest: every 2 h, 1 h grace. Last start 2.5 h ago: due 30 min ago, still within grace.
    await recordRun({ stage: "ingest", outcome: "ok", startedAt: hoursAgo(2.5) });
    const html = await page("/stages");
    expect(html).toContain('<span class="warn">late</span>');
  });

  it("shows the cap's cause wherever a capped mode is shown", async () => {
    await h.request("/v1/changes", {
      as: "owner",
      json: { target: "global", value: "off", reason: "drill" },
    });
    expect(await page("/health")).toContain("(capped by the master switch)");
  });
});

describe("health & alerts", () => {
  it("shows the alerts stage and every health check, with their forms posting back here", async () => {
    const html = await page("/health");
    expect(html).toContain("Health alerts");
    for (const id of POLICY_IDS.filter((p) =>
      (policyDef(p).readBy as readonly string[]).includes("alerts"),
    ))
      expect(html).toContain(`id="policy-${id}"`);
    expect(html).toContain('name="target" value="health.board_fail_ratio.threshold"');
    expect(html).toContain('name="back" value="/health"');
  });

  it("groups the checks under the stage each watches, greying those whose stage is off", async () => {
    await h.request("/v1/changes", { as: "owner", json: { target: "ingest", value: "on" } });
    await h.request("/v1/changes", { as: "owner", json: { target: "digest", value: "off" } });
    const html = await page("/health");
    const band = (stage: string) =>
      html.indexOf(`<li class="grp"><span><a href="/stages/${stage}"`);
    for (const id of POLICY_IDS.filter((p) =>
      (policyDef(p).readBy as readonly string[]).includes("alerts"),
    )) {
      const own = band(policyDef(id).watches ?? "");
      const at = html.indexOf(`id="policy-${id}"`);
      const next = html.indexOf('<li class="grp">', own + 1);
      expect(own).toBeGreaterThan(-1);
      expect(at).toBeGreaterThan(own);
      if (next !== -1) expect(at).toBeLessThan(next);
    }
    expect(html).toContain('User digests</a></span><span class="mode m-off">off</span></li>');
    expect(html).toContain('Ingest job boards</a></span><span class="mode m-on">on</span></li>');
    expect(html).toMatch(/<li class="item [^"]*\bidle" id="policy-health\.digest_health">/);
    expect(html).not.toMatch(/<li class="item [^"]*\bidle" id="policy-health\.board_fail_ratio">/);
  });
});

describe("runs", () => {
  it("lists the ledger newest first, filters it, and escapes runtime-written text", async () => {
    await recordRun({ stage: "ingest", outcome: "ok", startedAt: hoursAgo(3), detail: "run-one" });
    await recordRun({
      stage: "discover",
      outcome: "ok",
      startedAt: hoursAgo(2),
      detail: "run-two",
    });
    await recordRun({
      stage: "ingest",
      outcome: "error",
      startedAt: hoursAgo(1),
      detail: "<b>run-three</b>",
    });

    const all = await page("/runs");
    expect(all.indexOf("&lt;b&gt;run-three&lt;/b&gt;")).toBeLessThan(all.indexOf("run-two"));
    expect(all.indexOf("run-two")).toBeLessThan(all.indexOf("run-one"));
    expect(all).not.toContain("<b>run-three</b>");

    // The same calendar period picker as Cost; it carries across the Log's tabs with the stage.
    expect(all).toContain('<input type="date" name="from" value="">');
    expect(await page("/runs?stage=ingest&from=2026-10-01")).toContain(
      '<a href="/activity?stage=ingest&amp;from=2026-10-01">Changes</a>',
    );

    const discover = await page("/runs?stage=discover");
    expect(discover).toContain("run-two");
    expect(discover).not.toContain("run-one");
    const errors = await page("/runs?outcome=error");
    expect(errors).toContain("run-three");
    expect(errors).not.toContain("run-two");
  });

  it("marks a failed run's row and a gate that wasn't on", async () => {
    await recordRun({ stage: "ingest", outcome: "error", startedAt: hoursAgo(1), detail: "boom" });
    await recordRun({ stage: "ingest", outcome: "ok", startedAt: hoursAgo(2), gateMode: "off" });
    await recordRun(
      { stage: "embed", outcome: "ok", startedAt: hoursAgo(3), gateMode: "shadow" },
      "other-runtime",
    );
    const html = await page("/runs");
    expect(html.match(/<tr class="err">/g)).toHaveLength(1);
    expect(html).toContain("switch was off</span>");
    expect(html).toContain("switch was logs only</span>");
    expect(html).toContain(">switch unreadable</span>");
  });

  it("never prints a dangling 'took' for a run without a duration", async () => {
    await recordRun({ stage: "ingest", outcome: "ok", startedAt: hoursAgo(1) });
    expect(await page("/runs")).not.toMatch(/took\s*</);
  });

  it("refuses a bad filter with a readable error page", async () => {
    const res = await h.request("/runs?stage=<x>", { as: "owner" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("invalid_stage");
    expect(html).not.toContain("<x>");
  });
});

describe("log", () => {
  it("is one section with Runs, Changes and Proposals tabs, the stage filter carried across", async () => {
    const runs = await page("/runs?stage=ingest");
    expect(runs).toContain('<a href="/runs?stage=ingest" aria-current="page">Runs</a>');
    expect(runs).toContain('<a href="/activity?stage=ingest">Changes</a>');
    expect(runs).toContain('<a href="/proposals?stage=ingest">Proposals</a>');
    const changes = await page("/activity");
    expect(changes).toContain('<a href="/runs">Runs</a>');
    expect(changes).toContain('<a href="/activity" aria-current="page">Changes</a>');
    expect(await page("/proposals")).toContain(
      '<a href="/proposals" aria-current="page">Proposals</a>',
    );
  });

  it("keeps every closed proposal in the Proposals tab, while Approvals folds the latest away", async () => {
    const a = await fileProposal("embed", "on", "reason-alpha");
    const b = await fileProposal("digest", "shadow", "reason-beta");
    await h.request(`/ui/proposals/${a}/reject`, { as: "owner", form: { note: "" } });
    await h.request(`/ui/proposals/${b}/approve`, { as: "owner", form: { note: "" } });

    const approvals = await page("/approvals");
    expect(approvals).toContain(
      '<details class="card fold"><summary class="card-h"><h2>Recently closed (2)</h2>',
    );

    const log = await page("/proposals");
    expect(log.indexOf("reason-beta")).toBeLessThan(log.indexOf("reason-alpha"));
    expect(log).toContain('class="mode m-rejected">rejected</span>');
    expect(log).toContain('class="mode m-approved">approved</span>');
    const rejected = await page("/proposals?outcome=rejected");
    expect(rejected).toContain("reason-alpha");
    expect(rejected).not.toContain("reason-beta");

    const changes = await page("/activity");
    expect(changes).toContain(`proposal #${b} by <span title="agent:`);
  });
});

describe("activity", () => {
  it("folds the migration seed into one line and lists real changes in full", async () => {
    await h.request("/v1/changes", {
      as: "owner",
      json: { target: "embed", value: "shadow", reason: "count the backlog" },
    });
    const html = await page("/activity");
    expect(html).toContain("starting values from the migration seed");
    expect(html).toContain("count the backlog");
    expect(html.indexOf("count the backlog")).toBeLessThan(html.indexOf("migration seed"));
  });

  it("filters to one stage's own targets", async () => {
    await h.request("/v1/changes", {
      as: "owner",
      json: { target: "ingest.boardsPerTick", value: "200", reason: "smaller ticks" },
    });
    await h.request("/v1/changes", {
      as: "owner",
      json: { target: "embed", value: "shadow", reason: "count the backlog" },
    });
    const html = await page("/activity?stage=ingest");
    expect(html).toContain("smaller ticks");
    expect(html).not.toContain("count the backlog");
  });
  it("keeps a long reason to one line that opens on a click, and calls the viewer 'you'", async () => {
    const long = `${"x".repeat(40)} a reason long enough to need clipping`;
    await h.request("/v1/changes", {
      as: "owner",
      json: { target: "embed", value: "shadow", reason: long },
    });
    const html = await page("/activity");
    expect(html).toContain(
      `<details class="clip"><summary title="${long}">${long}</summary></details>`,
    );
    expect(html).toContain(">you</span>");
  });
});

describe("owner forms", () => {
  it("applies a change and lands back on the page it came from (channel panel)", async () => {
    const res = await h.request("/ui/change", {
      as: "owner",
      form: { target: "embed", value: "shadow", back: "/stages/embed" },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/stages/embed?done=applied");
    expect(await stateValue("embed")).toBe("shadow");
    const log = await h.db
      .prepare("SELECT channel, actor_role, reason FROM change_log ORDER BY id DESC LIMIT 1")
      .first();
    expect(log).toEqual({ channel: "panel", actor_role: "owner", reason: null });
    expect(await page("/activity")).toContain(">you</span>");
  });

  it.each(["https://evil.example/", "//evil.example", "/runs", "/stages/../x", ""])(
    "never redirects to %j: only to a panel page with forms, else home",
    async (back) => {
      const res = await h.request("/ui/change", {
        as: "owner",
        form: { target: "embed", value: "shadow", reason: "x", back },
      });
      expect(res.headers.get("location")).toBe("/?done=applied");
    },
  );

  it.each<[string, Record<string, string>]>([
    ["no Origin", { origin: "" }],
    ["a foreign Origin", { origin: "https://evil.example" }],
  ])("refuses a form post with %s (CSRF)", async (_label, headers) => {
    const res = await h.request("/ui/change", {
      as: "owner",
      headers,
      form: { target: "embed", value: "on", reason: "x" },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross_origin");
    expect(await stateValue("embed")).toBe("off");
  });

  it("shows a readable, escaped error page for an invalid change", async () => {
    const res = await h.request("/ui/change", {
      as: "owner",
      headers: { origin: ORIGIN },
      form: { target: "ingest", value: "<shadow>", reason: "x" },
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("invalid_value");
    expect(html).toContain("&lt;shadow&gt;");
    expect(html).toContain('href="/"');
  });
});
