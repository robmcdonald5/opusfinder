import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ORIGIN, startControl, type ControlHarness } from "@test/control/harness";

// The owner page: rendered from the same status the API returns, phone-friendly, script-free, every
// dynamic string escaped (agent-written reasons are untrusted), and form posts same-origin only.

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

async function stateValue(key: string): Promise<string | null> {
  const row = await h.db
    .prepare("SELECT value FROM state WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

describe("GET /", () => {
  it("renders status, knobs, proposals and the change log for the owner, with forms", async () => {
    const res = await h.request("/", { as: "owner" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const page = await res.text();
    expect(page).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    for (const text of [
      "Ingest job boards",
      "ingest.boardsPerTick",
      "Open proposals (0)",
      "Recent changes",
      "Flip a mode",
    ]) {
      expect(page).toContain(text);
    }
    expect(page).toContain('action="/ui/change"');
    expect(page).not.toMatch(/<script/i);
  });

  it("sets the hardening headers", async () => {
    const res = await h.request("/", { as: "owner" });
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("is read-only for an agent: no forms, no approve buttons", async () => {
    await h.request("/v1/proposals", {
      as: "agent",
      json: { target: "embed", value: "on", reason: "drain" },
    });
    const page = await (await h.request("/", { as: "agent" })).text();
    expect(page).toContain("read-only here");
    expect(page).toContain("Open proposals (1)");
    expect(page).not.toContain("<form");
  });

  it("escapes agent-written text", async () => {
    const reason = `<script>alert(1)</script> "quoted" & 'single'`;
    await h.request("/v1/proposals", {
      as: "agent",
      json: { target: "embed", value: "on", reason },
    });
    const page = await (await h.request("/", { as: "owner" })).text();
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot; &amp; &#39;single&#39;",
    );
  });

  it("shows only fixed flash messages (no reflected query text)", async () => {
    const page = await (await h.request("/?done=<b>pwned</b>", { as: "owner" })).text();
    expect(page).not.toContain("pwned");
    const ok = await (await h.request("/?done=applied", { as: "owner" })).text();
    expect(ok).toContain("Change applied and logged.");
  });
});

describe("owner forms", () => {
  it("applies a change from the page and redirects back (channel panel)", async () => {
    const res = await h.request("/ui/change", {
      as: "owner",
      form: { target: "embed", value: "shadow", reason: "count the backlog first" },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?done=applied");
    expect(await stateValue("embed")).toBe("shadow");
    const log = await h.db
      .prepare("SELECT channel, actor_role FROM change_log ORDER BY id DESC LIMIT 1")
      .first();
    expect(log).toEqual({ channel: "panel", actor_role: "owner" });
  });

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

  it("approves and rejects proposals from the page", async () => {
    const file = async (target: string, value: string) =>
      (
        (await (
          await h.request("/v1/proposals", { as: "agent", json: { target, value, reason: "r" } })
        ).json()) as {
          proposal: { id: number };
        }
      ).proposal.id;
    const a = await file("embed", "on");
    const b = await file("digest", "shadow");
    const page = await (await h.request("/", { as: "owner" })).text();
    expect(page).toContain(`action="/ui/proposals/${a}/approve"`);
    expect(page).toContain(`formaction="/ui/proposals/${a}/reject"`);

    const ok = await h.request(`/ui/proposals/${a}/approve`, {
      as: "owner",
      form: { note: "looks right" },
    });
    expect(ok.headers.get("location")).toBe("/?done=approved");
    expect(await stateValue("embed")).toBe("on");
    const decided = await h.db
      .prepare("SELECT status, decision_note FROM proposal WHERE id = ?")
      .bind(a)
      .first();
    expect(decided).toEqual({ status: "approved", decision_note: "looks right" });
    const no = await h.request(`/ui/proposals/${b}/reject`, { as: "owner", form: { note: "" } });
    expect(no.headers.get("location")).toBe("/?done=rejected");
    expect(await stateValue("digest")).toBe("off");
  });

  it("shows a stale proposal as stale (reject only), and a stale approve as a flash, not an error", async () => {
    const res = await h.request("/v1/proposals", {
      as: "agent",
      json: { target: "embed", value: "on", reason: "drain" },
    });
    const id = ((await res.json()) as { proposal: { id: number } }).proposal.id;
    await h.request("/v1/changes", {
      as: "owner",
      json: { target: "embed", value: "shadow", reason: "count first" },
    });

    const page = await (await h.request("/", { as: "owner" })).text();
    expect(page).toContain("Stale:");
    expect(page).not.toContain(`action="/ui/proposals/${id}/approve"`);
    expect(page).toContain(`action="/ui/proposals/${id}/reject"`);

    // A form posted before the page refreshed still lands safely: nothing applied, a clear flash.
    const ok = await h.request(`/ui/proposals/${id}/approve`, { as: "owner", form: { note: "" } });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/?done=stale");
    expect(await stateValue("embed")).toBe("shadow");
    const after = await (await h.request("/?done=stale", { as: "owner" })).text();
    expect(after).toContain("That proposal was stale");
    expect(after).toContain("Recently closed proposals (1)");
    expect(after).toContain('class="mode m-stale">stale</span>');
  });

  it("shows a readable, escaped error page for an invalid change", async () => {
    const res = await h.request("/ui/change", {
      as: "owner",
      headers: { origin: ORIGIN },
      form: { target: "ingest", value: "<shadow>", reason: "x" },
    });
    expect(res.status).toBe(400);
    const page = await res.text();
    expect(page).toContain("invalid_value");
    expect(page).toContain("&lt;shadow&gt;");
    expect(page).toContain('href="/"');
  });
});
