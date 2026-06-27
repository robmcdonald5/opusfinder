/**
 * Shared HTML → plain-text primitive for the ATS adapters. The decode/strip/collapse
 * ATOMS are invariant; only their ORDER varies per source, so `cleanHtml` takes an
 * ordered step list rather than scalar knobs.
 *
 * Why an ordered list (not a `{ passes, stripFirst }` pair): Greenhouse double-encodes
 * asymmetrically — structural tags are single-encoded (`&lt;div&gt;`) while inner text
 * entities are double-encoded (`&amp;nbsp;`) — so its pipeline is
 * decode → strip → decode → collapse, with the tag-strip SANDWICHED between two decode
 * passes. A two-knob model cannot express "strip in the middle"; an ordered list can,
 * and reproduces every source byte-for-byte:
 *   - Greenhouse:                ["decode", "strip", "decode", "collapse"]
 *   - SmartRecruiters/Workable:  ["strip", "decode", "collapse"]   (raw tags, single-encoded)
 *   - Lever/Ashby (plain text):  ["collapse"]                      (already plain)
 *
 * Pure string operations only — no Node APIs — so this runs unchanged in a Cloudflare Worker.
 */
export type CleanStep = "decode" | "strip" | "collapse";

export function cleanHtml(input: string, steps: readonly CleanStep[]): string {
  let s = input;
  for (const step of steps) {
    if (step === "decode") s = decodeEntities(s);
    else if (step === "strip") s = s.replace(/<[^>]*>/g, " ");
    else s = s.replace(/\s+/g, " ").trim();
  }
  return s;
}

/**
 * The canonical "raw tags + single-encoded entities" cleaner: coerce a value to a string
 * (non-strings → ""), then strip → decode one entity layer → collapse. Most ATS description
 * fields are this shape (Workable / SmartRecruiters / Pinpoint / Recruitee / Trakstar, and the
 * HTML fallback of Gem / Ashby), so this names the recipe once. Greenhouse's asymmetric
 * DOUBLE-encoding is the exception and calls `cleanHtml(..., ["decode","strip","decode","collapse"])`
 * directly; plain-text fields use `cleanHtml(..., ["collapse"])`.
 */
export function htmlToText(value: unknown): string {
  return cleanHtml(typeof value === "string" ? value : "", ["strip", "decode", "collapse"]);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode ONE layer of HTML entities: the common named set + numeric dec/hex. */
function decodeEntities(input: string): string {
  return input.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match: string, ref: string) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X"
          ? Number.parseInt(ref.slice(2), 16)
          : Number.parseInt(ref.slice(1), 10);
      return decodeCodePoint(code, match);
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
  });
}

/**
 * A numeric code point → its character, or `fallback` (the raw entity text) for anything
 * that would crash or yield invalid/unsafe text: out-of-range values (`fromCodePoint`
 * throws above 0x10FFFF), lone surrogates, and C0 control chars other than tab/newline/CR
 * (e.g. a NUL a downstream text column would reject).
 */
function decodeCodePoint(code: number, fallback: string): string {
  if (!Number.isInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return fallback;
  }
  if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
    return fallback;
  }
  return String.fromCodePoint(code);
}
