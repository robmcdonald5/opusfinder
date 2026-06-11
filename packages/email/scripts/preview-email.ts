import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { DigestEmailPayload } from "@opusfinder/db/repos";
import { runScript } from "@opusfinder/shared/script";
import type { UserId } from "@opusfinder/shared";

import { renderDigestEmail } from "../src/render";

/**
 * Credential-free render preview (Phase 11c gate): a built-in fixture payload → `email-preview.html`
 * (open it in a browser) + the text part on stdout. No creds, no DB, no network. The fixture
 * deliberately carries HOSTILE scraped input — a `<script>` title, a `javascript:` apply URL, quotes
 * in the reason — so an escaping/scheme-gate regression is VISIBLE in this gate, not just in the 11d
 * smoke assertions.
 *
 *   pnpm email:preview
 */
const FIXTURE: DigestEmailPayload = {
  digestId: 0,
  userId: "00000000-0000-0000-0000-000000000000" as UserId,
  recipient: { email: "preview@example.com", name: "Preview User" },
  createdAt: new Date("2026-06-11T00:00:00Z"), // fixed — the render path itself takes no clock
  items: [
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
      // HOSTILE item: script tag in the title, javascript: URL, quotes + entities in the reason.
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
      reason:
        "Smaller team, broader ownership; matches your stated preference for early-stage work.",
      title: "Founding Engineer, Platform",
      companySlug: "tiny-startup",
      applyUrl: "https://jobs.example.com/tiny-startup/founding-engineer",
      locations: ["Remote (EU)"],
      remote: true,
    },
  ],
};

await runScript("preview-email", async () => {
  const rendered = renderDigestEmail(FIXTURE);

  const outPath = fileURLToPath(new URL("../email-preview.html", import.meta.url));
  writeFileSync(outPath, rendered.html, "utf8");

  console.log(`subject: ${rendered.subject}`);
  console.log(`html:    ${outPath} (${rendered.html.length} chars — open in a browser)`);
  console.log(`\n--- text part ---\n${rendered.text}\n--- end text part ---`);
});
