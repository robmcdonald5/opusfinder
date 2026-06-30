import { describe, expect, it } from "vitest";

import { cleanHtml, htmlToText } from "./text";

// Phase 1 leaf pure-unit (no workspace deps). Locks the HTML → plain-text primitive shared by every
// ATS adapter. Load-bearing: the decode/strip/collapse ORDER is what makes each source byte-exact —
// Greenhouse double-encodes asymmetrically and only a SANDWICHED strip (decode→strip→decode→collapse)
// recovers its text, while htmlToText must coerce non-string ATS payloads to "" rather than throwing
// mid-pipeline. Numeric-codepoint guards keep an unsafe NUL / out-of-range entity out of the text column.
describe("cleanHtml", () => {
  // Frozen, deterministic fixtures — fixed entity sequences, never re-derived per run.
  const GREENHOUSE_STEPS = ["decode", "strip", "decode", "collapse"] as const;
  const RAW_STEPS = ["strip", "decode", "collapse"] as const;

  it("recovers Greenhouse asymmetric double-encoding (single-encoded tags + double-encoded inner entities)", () => {
    // Structural tags single-encoded (&lt;p&gt;), inner text entities double-encoded (&amp;nbsp;).
    const input = "&lt;p&gt;Senior&amp;nbsp;Engineer&lt;/p&gt;";
    expect(cleanHtml(input, GREENHOUSE_STEPS)).toBe("Senior Engineer");
  });

  it("strips raw single-encoded tags and decodes one entity layer (Workable/SmartRecruiters shape)", () => {
    const input = "<div>R&amp;D &lt;ok&gt;</div>";
    expect(cleanHtml(input, RAW_STEPS)).toBe("R&D <ok>");
  });

  it("collapse-only leaves plain text intact apart from whitespace (Lever/Ashby shape)", () => {
    const input = "  already   plain\n\ttext  ";
    expect(cleanHtml(input, ["collapse"])).toBe("already plain text");
  });

  describe("entity decoding", () => {
    it.each([
      ["&amp;", "&"],
      ["&lt;", "<"],
      ["&gt;", ">"],
      ["&quot;", '"'],
      ["&apos;", "'"],
      ["&nbsp;", " "],
      ["&AMP;", "&"], // named lookup is case-insensitive
      ["&#38;", "&"], // decimal codepoint
      ["&#x26;", "&"], // hex codepoint, lowercase x
      ["&#X26;", "&"], // hex codepoint, uppercase X
      ["&#233;", "é"], // é via decimal
      ["&#x1F600;", "\u{1F600}"], // astral plane (emoji) via hex
    ])("decodes %j → %j", (input, expected) => {
      expect(cleanHtml(input, ["decode"])).toBe(expected);
    });

    it.each([
      ["&unknownent;", "&unknownent;"], // unknown named entity passes through verbatim
      ["&amp", "&amp"], // missing semicolon is not an entity
      ["bare & ampersand", "bare & ampersand"], // lone ampersand untouched
    ])("leaves %j unchanged", (input, expected) => {
      expect(cleanHtml(input, ["decode"])).toBe(expected);
    });

    it.each([
      ["&#x110000;", "&#x110000;"], // > 0x10FFFF: fromCodePoint would throw
      ["&#xD800;", "&#xD800;"], // lone high surrogate
      ["&#xDFFF;", "&#xDFFF;"], // lone low surrogate
      ["&#0;", "&#0;"], // NUL — a text column would reject it
      ["&#1;", "&#1;"], // C0 control other than tab/newline/CR
    ])("falls back to raw entity text for unsafe codepoint %j", (input, expected) => {
      expect(cleanHtml(input, ["decode"])).toBe(expected);
    });

    it.each([
      ["a&#9;b", "a\tb"], // tab is allowed
      ["a&#10;b", "a\nb"], // newline is allowed
      ["a&#13;b", "a\rb"], // carriage return is allowed
    ])("allows whitelisted control codepoint %j", (input, expected) => {
      expect(cleanHtml(input, ["decode"])).toBe(expected);
    });
  });

  describe("tag stripping", () => {
    it("replaces each tag with a space so adjacent words stay separated", () => {
      expect(cleanHtml("<b>a</b><i>b</i>", ["strip"])).toBe(" a  b ");
    });

    it("strips multi-attribute and self-closing tags", () => {
      expect(cleanHtml('<a href="x" target="_blank">link</a><br/>', ["strip"])).toBe(" link  ");
    });

    it("leaves a malformed tag with no closing '>' intact (strip is bounded by the closing bracket)", () => {
      expect(cleanHtml("a <unclosed b", ["strip"])).toBe("a <unclosed b");
    });
  });

  describe("whitespace collapse", () => {
    it("collapses runs of mixed whitespace to a single space and trims the ends", () => {
      expect(cleanHtml("\n\n  foo \t bar \r\n baz  ", ["collapse"])).toBe("foo bar baz");
    });
  });

  it("applies no transform for an empty step list (identity)", () => {
    expect(cleanHtml("<p>untouched</p>", [])).toBe("<p>untouched</p>");
  });
});

describe("htmlToText", () => {
  it("runs the canonical strip → decode → collapse recipe on a string", () => {
    const input = "<ul>\n  <li>Build &amp; ship</li>\n  <li>R&amp;D</li>\n</ul>";
    expect(htmlToText(input)).toBe("Build & ship R&D");
  });

  it("returns empty string for an empty string", () => {
    expect(htmlToText("")).toBe("");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["object", { description: "<p>x</p>" }],
    ["array", ["<p>x</p>"]],
    ["boolean", true],
  ])("coerces non-string %s input to empty string instead of throwing", (_label, value) => {
    expect(htmlToText(value)).toBe("");
  });
});
