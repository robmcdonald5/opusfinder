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
    // `[^<>]`, not `[^>]`: the latter rescans the rest of the input for every unclosed "<" (quadratic).
    else if (step === "strip") s = dropUnrendered(s).replace(/<[^<>]*>/g, " ");
    else s = s.replace(/\s+/g, " ").trim();
  }
  return s;
}

/**
 * Drop text a browser never renders but a tag strip alone would keep: comments (Word pastes hide
 * their mso XML in conditional comments) and <script>/<style> bodies. One forward scan, not a lazy
 * regex (quadratic on many unclosed openers); an unclosed one ends the scan and the rest is kept.
 */
function dropUnrendered(input: string): string {
  const open = /<!--|<(script|style)\b/gi;
  let out = "";
  let from = 0;
  for (let m = open.exec(input); m !== null; m = open.exec(input)) {
    const close = m[1] ? new RegExp(`</${m[1]}`, "gi") : /-->/g;
    close.lastIndex = open.lastIndex;
    const end = close.exec(input);
    if (end === null) break;
    out += `${input.slice(from, m.index)} `;
    // A body ends at its end tag (the tag strip removes that); a comment after its "-->".
    from = open.lastIndex = m[1] ? end.index : close.lastIndex;
  }
  return out + input.slice(from);
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

/**
 * Join already-cleaned description sections, skipping empty ones, with a blank line between them.
 * Callers pass sections in a FIXED order: a reorder would change `content_signature` and needlessly
 * NULL the embedding on re-ingest.
 */
export function joinSections(sections: readonly string[]): string {
  return sections.filter((s) => s.length > 0).join("\n\n");
}

// The Latin-1 entity names, one row per 16 code points from U+00A0.
const LATIN1 = `
  nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr
  deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest
  Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml
  ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig
  agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml
  eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml`;

// Name/character pairs for the rest of Windows-1252: the typography Word and rich-text editors emit.
const CP1252 = `
  euro € sbquo ‚ fnof ƒ bdquo „ hellip … dagger † Dagger ‡ circ ˆ permil ‰ Scaron Š lsaquo ‹ OElig Œ
  Zcaron Ž lsquo ‘ rsquo ’ ldquo “ rdquo ” bull • ndash – mdash — tilde ˜ trade ™ scaron š rsaquo ›
  oelig œ zcaron ž Yuml Ÿ`;

const NAMED_ENTITIES = new Map<string, string>([
  ...LATIN1.trim()
    .split(/\s+/)
    .map((name, i) => [name, String.fromCodePoint(0xa0 + i)] as const),
  ...Array.from(CP1252.matchAll(/(\w+) (\S)/g), ([, name = "", ch = ""]) => [name, ch] as const),
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
]);

const ENTITY = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;

/** Decode ONE layer of HTML entities: the common named set + numeric dec/hex. */
function decodeEntities(input: string): string {
  return input.replace(ENTITY, (match: string, ref: string) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X"
          ? Number.parseInt(ref.slice(2), 16)
          : Number.parseInt(ref.slice(1), 10);
      return decodeCodePoint(code, match);
    }
    // Exact first: letter entities are case-sensitive (&Uuml; Ü, &uuml; ü).
    return NAMED_ENTITIES.get(ref) ?? NAMED_ENTITIES.get(ref.toLowerCase()) ?? match;
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
