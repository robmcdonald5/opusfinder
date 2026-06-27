import type { DigestEmailPayload } from "@opusfinder/db/repos";

/**
 * PURE digest-email render: payload in → `{subject, html, text}` out. No I/O, no env, and — load-
 * bearing — NO CLOCK and no randomness anywhere in this module: the rendered payload must be
 * byte-identical across Inngest step retries, or Resend rejects the idempotency-key replay with a
 * 409 `invalid_idempotent_request`. The only date this template may show is `payload.createdAt`.
 *
 * Every interpolated field is HTML-escaped: titles/reasons/slugs are SCRAPED ATS content rendered
 * into an inbox — untrusted external input. `applyUrl` is additionally scheme-gated to http(s); a
 * scraped `javascript:` URL degrades to escaped plain text, never an href.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** `& < > " '` — covers element text AND double-quoted attribute values. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The URL if it parses with an http:/https: scheme; `null` for anything else (incl. unparseable). */
function safeHttpUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? raw : null;
}

/** "City, City · Remote" / "Remote" / "Location unlisted" — one deterministic line per item. */
function formatWhere(locations: string[], remote: boolean): string {
  const parts = locations.map((l) => l.trim()).filter((l) => l.length > 0);
  if (remote) parts.push("Remote");
  return parts.length > 0 ? parts.join(" · ") : "Location unlisted";
}

export function renderDigestEmail(payload: DigestEmailPayload): RenderedEmail {
  const n = payload.items.length;
  const date = payload.createdAt.toISOString().slice(0, 10); // UTC — no host-timezone drift
  const rolesSummary = `${n} matched role${n === 1 ? "" : "s"}`;
  const subject = `Your opusfinder digest — ${rolesSummary} (${date})`;

  const itemsHtml = payload.items
    .map((item) => {
      const url = safeHttpUrl(item.applyUrl);
      const apply = url
        ? `<a href="${escapeHtml(url)}" style="color:#1a73e8;">Apply</a>`
        : // Non-http(s) scheme: show it inert as text so a hostile link is never clickable.
          `<span style="color:#888;">apply URL withheld (non-http): ${escapeHtml(item.applyUrl)}</span>`;
      return [
        `<tr><td style="padding:14px 0;border-bottom:1px solid #e3e3e3;">`,
        `<div style="font-size:16px;font-weight:bold;color:#222;">${item.rank}. ${escapeHtml(item.title)} — ${escapeHtml(item.companySlug)}</div>`,
        `<div style="font-size:13px;color:#555;margin:4px 0;">${escapeHtml(formatWhere(item.locations, item.remote))}</div>`,
        `<div style="font-size:14px;color:#222;margin:4px 0;">${escapeHtml(item.reason)}</div>`,
        `<div style="font-size:14px;">${apply}</div>`,
        `</td></tr>`,
      ].join("");
    })
    .join("\n");

  // One column, inline styles, no assets — minimal HTML. NO unsubscribe link (a dead link is worse
  // than none).
  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f6f6f6;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:16px;">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:6px;padding:24px;">
<tr><td>
<h1 style="font-size:20px;margin:0 0 4px;color:#222;">Your opusfinder digest</h1>
<div style="font-size:13px;color:#555;margin-bottom:8px;">${escapeHtml(date)} — ${rolesSummary} for ${escapeHtml(payload.recipient.name)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${itemsHtml}
</table>
<div style="font-size:12px;color:#888;margin-top:20px;">Sent by opusfinder. Managing delivery arrives with the web app.</div>
</td></tr>
</table>
</td></tr></table>
</body>
</html>`;

  const itemsText = payload.items
    .map((item) =>
      [
        `${item.rank}. ${item.title} — ${item.companySlug}`,
        `   ${formatWhere(item.locations, item.remote)}`,
        `   ${item.reason}`,
        `   Apply: ${item.applyUrl}`,
      ].join("\n"),
    )
    .join("\n\n");

  const text = [
    `Your opusfinder digest — ${rolesSummary} (${date})`,
    `For ${payload.recipient.name}`,
    ``,
    itemsText,
    ``,
    `Sent by opusfinder. Managing delivery arrives with the web app.`,
  ].join("\n");

  return { subject, html, text };
}
