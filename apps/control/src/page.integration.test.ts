import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POLICY_IDS, STAGE_IDS, policyDef } from "@opusfinder/control";
import { ORIGIN, startControl, type ControlHarness } from "@test/control/harness";

// The owner panel: a home page of sections, each its own page, all rendered from the same reads the API
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

async function recordRun(run: Record<string, unknown>): Promise<void> {
  const res = await h.request("/v1/runs", { as: "runtime", json: run });
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
    expect(await page("/health")).toContain('<a href="/health" aria-current="page">');
    expect(await page("/stages/ingest")).toContain('<a href="/stages" aria-current="page">');
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
    expect(await page("/stages?done=applied")).toContain("Change applied and logged.");
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

describe("home", () => {
  it("is a card per section, each linking to its page", async () => {
    const html = await page("/");
    for (const path of ["/approvals", "/stages", "/health", "/runs", "/cost", "/activity"]) {
      expect(html).toContain(`<a class="tile" href="${path}">`);
    }
    expect(html).not.toContain('method="post"');
  });

  it("puts live status on the cards", async () => {
    let html = await page("/");
    expect(html).toContain("Nothing waiting");
    expect(html).toContain("0 in 24 h");

    await fileProposal("embed", "on");
    await recordRun({ stage: "ingest", outcome: "error", startedAt: hoursAgo(1), detail: "boom" });
    html = await page("/");
    expect(html).toContain("1 waiting");
    expect(html).toContain("1 in 24 h");
    expect(html).toContain("1 failed");
    expect(html).toContain("8 checks: 8 shadow");
  });

  it("flags an overdue stage", async () => {
    // ingest expects a run every 2 h with 1 h grace: a last run 4 h ago is overdue.
    await recordRun({ stage: "ingest", outcome: "ok", startedAt: hoursAgo(4) });
    expect(await page("/")).toContain("1 overdue (ingest)");
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

  it("links a proposal's target to where it lives", async () => {
    await fileProposal("ingest.boardsPerTick", "400");
    await fileProposal("health.board_fail_ratio", "enforce");
    const html = await page("/approvals");
    expect(html).toContain('<a href="/stages/ingest"><code>ingest.boardsPerTick</code></a>');
    expect(html).toContain('<a href="/health"><code>health.board_fail_ratio</code></a>');
  });

  it("approves and rejects from the page and lands back on it", async () => {
    const a = await fileProposal("embed", "on");
    const b = await fileProposal("digest", "shadow");
    const html = await page("/approvals");
    expect(html).toContain(`action="/ui/proposals/${a}/approve"`);
    expect(html).toContain(`formaction="/ui/proposals/${a}/reject"`);

    const ok = await h.request(`/ui/proposals/${a}/approve`, {
      as: "owner",
      form: { note: "looks right" },
    });
    expect(ok.headers.get("location")).toBe("/approvals?done=approved");
    expect(await stateValue("embed")).toBe("on");
    const decided = await h.db
      .prepare("SELECT status, decision_note FROM proposal WHERE id = ?")
      .bind(a)
      .first();
    expect(decided).toEqual({ status: "approved", decision_note: "looks right" });
    const no = await h.request(`/ui/proposals/${b}/reject`, { as: "owner", form: { note: "" } });
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
    expect(html).toContain("Not everything obeys this page yet");
  });

  it("offers each switch only its own modes", async () => {
    const html = await page("/stages/ingest");
    // ingest is off|on: its mode form has no shadow option.
    const form = html.slice(html.indexOf('name="target" value="ingest"'));
    const select = form.slice(0, form.indexOf("</select>"));
    expect(select).toContain('<option value="off">off</option>');
    expect(select).toContain('<option value="on" selected>on (now)</option>');
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
    expect(html).toContain("<code>ingest.boardsPerTick</code>");
    expect(html).toContain('name="target" value="ingest.boardsPerTick"');
    expect(html).toContain('type="number"');
    expect(html).toContain('<option value="ingest@source=smartrecruiters">');
    expect(html).toContain("<strong>workable</strong>: set to");
    expect(html).toContain('href="/stages#policy-close"');
    expect(html).toContain("Health checks watching it");
    expect(html).toContain("208/208 boards · 2 failed");
    expect(html).toContain("4 min 10 s");
    expect(html).toContain("429 storm");
    expect(html).toContain('href="/runs?stage=ingest"');
  });

  it("says plainly whether the runtime obeys the switch, and what happens when the plane is down", async () => {
    const ingest = await page("/stages/ingest");
    expect(ingest).toContain("Shadow: the runtime reads this switch");
    expect(ingest).toContain("logs that it would skip, then runs anyway");
    expect(ingest).not.toContain("fail closed");
    const embed = await page("/stages/embed");
    expect(embed).toContain("Not wired yet");
    expect(embed).toContain("the runtime doesn&#39;t read it yet");
  });

  it("calls a run due within its grace late, not 'due … ago'", async () => {
    // ingest: every 2 h, 1 h grace. Last start 2.5 h ago: due 30 min ago, still within grace.
    await recordRun({ stage: "ingest", outcome: "ok", startedAt: hoursAgo(2.5) });
    const html = await page("/stages");
    expect(html).toContain('<span class="warn">late</span>');
    expect(html).not.toContain("next due 30 min ago");
  });

  it("shows the cap's cause wherever a capped mode is shown", async () => {
    await h.request("/v1/changes", {
      as: "owner",
      json: { target: "global", value: "off", reason: "drill" },
    });
    expect(await page("/health")).toContain("(capped by global)");
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
});

describe("runs", () => {
  it("lists the ledger newest first, filters it, and escapes runtime-written text", async () => {
    await recordRun({ stage: "ingest", outcome: "ok", startedAt: hoursAgo(3), detail: "first" });
    await recordRun({ stage: "discover", outcome: "ok", startedAt: hoursAgo(2), detail: "second" });
    await recordRun({
      stage: "ingest",
      outcome: "error",
      startedAt: hoursAgo(1),
      detail: "<b>third</b>",
    });

    const all = await page("/runs");
    expect(all.indexOf("&lt;b&gt;third&lt;/b&gt;")).toBeLessThan(all.indexOf("second"));
    expect(all.indexOf("second")).toBeLessThan(all.indexOf("first"));
    expect(all).not.toContain("<b>third</b>");

    const discover = await page("/runs?stage=discover");
    expect(discover).toContain("second");
    expect(discover).not.toContain("first");
    const errors = await page("/runs?outcome=error");
    expect(errors).toContain("third");
    expect(errors).not.toContain("second");
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
});

describe("owner forms", () => {
  it("applies a change and lands back on the page it came from (channel panel)", async () => {
    const res = await h.request("/ui/change", {
      as: "owner",
      form: {
        target: "embed",
        value: "shadow",
        reason: "count the backlog first",
        back: "/stages/embed",
      },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/stages/embed?done=applied");
    expect(await stateValue("embed")).toBe("shadow");
    const log = await h.db
      .prepare("SELECT channel, actor_role FROM change_log ORDER BY id DESC LIMIT 1")
      .first();
    expect(log).toEqual({ channel: "panel", actor_role: "owner" });
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
