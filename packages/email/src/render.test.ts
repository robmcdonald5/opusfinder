import { describe, expect, it } from "vitest";

import type { DigestEmailPayload } from "@opusfinder/db/repos";

import { renderDigestEmail } from "./render";

// Leaf pure-unit (no DB/net/clock). This render path is the LAST hop before scraped ATS content lands
// in someone's inbox, and its output is the Resend idempotency-key payload — so two properties are
// load-bearing: (1) every interpolated field is HTML-escaped and `applyUrl` is scheme-gated to http(s),
// so a hostile `<script>` title or `javascript:` link is neutralized, never clickable; (2) the render
// takes NO clock and NO randomness, so the same payload renders byte-identically across step retries
// (a drifted payload makes Resend reject the replay with 409). `escapeHtml`/`safeHttpUrl`/`formatWhere`
// are module-private, so we assert their behavior through the exported `renderDigestEmail` surface.

// Frozen base — fixed createdAt so the rendered date/subject is deterministic and never host-clock-derived.
const CREATED_AT = new Date("2026-06-11T00:00:00Z");
const USER_ID = "00000000-0000-0000-0000-000000000000" as DigestEmailPayload["userId"];

type Item = DigestEmailPayload["items"][number];

const BENIGN_ITEM: Item = {
  rank: 1,
  reason: "Strong overlap with your distributed-systems experience.",
  title: "Senior Backend Engineer",
  companySlug: "acme-robotics",
  applyUrl: "https://boards.example.com/acme-robotics/jobs/123",
  locations: ["Berlin, Germany", "Amsterdam, Netherlands"],
  remote: false,
};

function makePayload(items: Item[], overrides: Partial<DigestEmailPayload> = {}): DigestEmailPayload {
  return {
    digestId: 0,
    userId: USER_ID,
    recipient: { email: "preview@example.com", name: "Preview User" },
    createdAt: CREATED_AT,
    approvedAt: new Date("2026-06-10T00:00:00Z"),
    items,
    ...overrides,
  };
}

// Absorbed verbatim from packages/email/scripts/preview-email.ts — the deliberately HOSTILE fixture
// (a `<script>` title, a `javascript:` apply URL, quotes + `&` + `<profile>` in the reason). Frozen so
// the regression these inputs are meant to catch is pinned here, not only visible in the manual preview.
const HOSTILE_PAYLOAD: DigestEmailPayload = makePayload([
  {
    rank: 1,
    reason:
      "Strong overlap with your distributed-systems experience; the role's Rust + Postgres stack matches your last two positions.",
    title: "Senior Backend Engineer",
    companySlug: "acme-robotics",
    applyUrl: "https://boards.example.com/acme-robotics/jobs/123",
    locations: ["Berlin, Germany", "Amsterdam, Netherlands"],
    remote: false,
  },
  {
    rank: 2,
    reason: `They want someone who's shipped "real-time" pipelines — your <profile> says you have & more.`,
    title: `<script>alert("xss")</script> Staff Engineer`,
    companySlug: "evil-corp",
    applyUrl: "javascript:alert('xss')",
    locations: [],
    remote: true,
  },
  {
    rank: 3,
    reason: "Smaller team, broader ownership; matches your stated preference for early-stage work.",
    title: "Founding Engineer, Platform",
    companySlug: "tiny-startup",
    applyUrl: "https://jobs.example.com/tiny-startup/founding-engineer",
    locations: ["Remote (EU)"],
    remote: true,
  },
]);

describe("renderDigestEmail — XSS escaping (escapeHtml)", () => {
  const { html } = renderDigestEmail(HOSTILE_PAYLOAD);

  it("never emits the raw <script> payload from a hostile title", () => {
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("</script>");
  });

  it("renders the hostile title as escaped, inert text", () => {
    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; Staff Engineer");
  });

  it("escapes &, <, >, double- and single-quotes in the reason field", () => {
    // `someone who's shipped "real-time" ... your <profile> ... have & more.`
    expect(html).toContain("someone who&#39;s shipped &quot;real-time&quot;");
    expect(html).toContain("your &lt;profile&gt; says you have &amp; more.");
  });

  it("escapes a hostile companySlug in the title line", () => {
    // companySlug is its own scraped-content interpolation (render.ts builds `title — companySlug`).
    const { html: out } = renderDigestEmail(
      makePayload([{ ...BENIGN_ITEM, companySlug: `<img src=x onerror="alert(1)">` }]),
    );
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(out).not.toContain("<img src=x");
  });

  it("escapes a hostile recipient name in the header line", () => {
    // recipient.name is interpolated into the HTML header — also untrusted, also escaped.
    const { html: out } = renderDigestEmail(
      makePayload([BENIGN_ITEM], {
        recipient: { email: "preview@example.com", name: `<script>steal()</script>` },
      }),
    );
    expect(out).toContain("&lt;script&gt;steal()&lt;/script&gt;");
    expect(out).not.toContain("<script>steal");
  });
});

describe("renderDigestEmail — applyUrl scheme gate (safeHttpUrl)", () => {
  it("renders an http(s) apply URL as a real, escaped href", () => {
    const { html } = renderDigestEmail(makePayload([BENIGN_ITEM]));
    expect(html).toContain(
      `<a href="https://boards.example.com/acme-robotics/jobs/123" style="color:#1a73e8;">Apply</a>`,
    );
  });

  it.each([
    "http://jobs.example.com/x",
    "https://jobs.example.com/x",
  ])("allows scheme of %j (clickable href)", (applyUrl) => {
    const { html } = renderDigestEmail(makePayload([{ ...BENIGN_ITEM, applyUrl }]));
    expect(html).toContain(`<a href="${applyUrl}" style="color:#1a73e8;">Apply</a>`);
    expect(html).not.toContain("apply URL withheld");
  });

  it.each([
    "javascript:alert('xss')",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "mailto:evil@example.com",
    "ftp://example.com/file",
    "file:///etc/passwd",
    "//protocol-relative.example.com",
    "not a url at all",
    "",
  ])("rejects non-http(s) / unparseable %j (withheld, never an href)", (applyUrl) => {
    const { html } = renderDigestEmail(makePayload([{ ...BENIGN_ITEM, applyUrl }]));
    expect(html).toContain("apply URL withheld (non-http):");
    expect(html).not.toContain(`<a href="${applyUrl}"`);
  });

  it("escapes the withheld hostile URL so its inert text cannot break out of the span", () => {
    const { html } = renderDigestEmail(makePayload([{ ...BENIGN_ITEM, applyUrl: "javascript:alert('xss')" }]));
    // Single quotes in the rejected URL must be entity-escaped, not rendered raw.
    expect(html).toContain("apply URL withheld (non-http): javascript:alert(&#39;xss&#39;)");
    expect(html).not.toContain("href=\"javascript:");
  });
});

describe("renderDigestEmail — location line (formatWhere)", () => {
  // The text part renders formatWhere output verbatim (unescaped), so it isolates the join logic cleanly.
  function whereLine(locations: string[], remote: boolean): string {
    const { text } = renderDigestEmail(makePayload([{ ...BENIGN_ITEM, locations, remote }]));
    // Indented location line is the 2nd line of the item block.
    const line = text.split("\n").find((l) => l.startsWith("   ") && !l.includes("Apply:"));
    return line!.trim();
  }

  it.each([
    { locations: ["Berlin, Germany", "Amsterdam, Netherlands"], remote: false, expected: "Berlin, Germany · Amsterdam, Netherlands" },
    { locations: ["Berlin, Germany"], remote: true, expected: "Berlin, Germany · Remote" },
    { locations: [], remote: true, expected: "Remote" },
    { locations: [], remote: false, expected: "Location unlisted" },
    { locations: ["  ", ""], remote: false, expected: "Location unlisted" }, // whitespace-only entries are dropped
    { locations: ["  Berlin  "], remote: false, expected: "Berlin" }, // each entry is trimmed
    { locations: ["  ", "Remote (EU)"], remote: false, expected: "Remote (EU)" },
  ])("$locations + remote=$remote → $expected", ({ locations, remote, expected }) => {
    expect(whereLine(locations, remote)).toBe(expected);
  });
});

describe("renderDigestEmail — subject + date", () => {
  it("pluralizes the role count and stamps the UTC date from createdAt", () => {
    const { subject } = renderDigestEmail(HOSTILE_PAYLOAD); // 3 items
    expect(subject).toBe("Your opusfinder digest — 3 matched roles (2026-06-11)");
  });

  it("uses the singular 'role' for exactly one item", () => {
    const { subject } = renderDigestEmail(makePayload([BENIGN_ITEM]));
    expect(subject).toBe("Your opusfinder digest — 1 matched role (2026-06-11)");
  });

  it("reports 0 matched roles for an empty (fully-closed) digest", () => {
    const { subject } = renderDigestEmail(makePayload([]));
    expect(subject).toBe("Your opusfinder digest — 0 matched roles (2026-06-11)");
  });

  it("derives the date from createdAt in UTC, ignoring host timezone", () => {
    // 23:30Z must still render as the 11th (a host-local conversion would slip to the 12th in +UTC zones).
    const { subject, text } = renderDigestEmail(
      makePayload([BENIGN_ITEM], { createdAt: new Date("2026-06-11T23:30:00Z") }),
    );
    expect(subject).toContain("(2026-06-11)");
    expect(text).toContain("(2026-06-11)");
  });
});

describe("renderDigestEmail — determinism", () => {
  it("renders byte-identical output for the same payload across calls (idempotency-key contract)", () => {
    const a = renderDigestEmail(HOSTILE_PAYLOAD);
    const b = renderDigestEmail(HOSTILE_PAYLOAD);
    expect(a).toEqual(b);
    expect(a.html).toBe(b.html);
    expect(a.subject).toBe(b.subject);
    expect(a.text).toBe(b.text);
  });

  it("returns a RenderedEmail with all three string parts populated", () => {
    const rendered = renderDigestEmail(HOSTILE_PAYLOAD);
    expect(rendered).toEqual({
      subject: expect.any(String),
      html: expect.any(String),
      text: expect.any(String),
    });
    expect(rendered.html.length).toBeGreaterThan(0);
  });
});
