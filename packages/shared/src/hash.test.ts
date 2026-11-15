import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sha256Hex } from "./hash";

// Prefixes of these digests are stored (location request ids) or sent as routing keys (prompt-cache
// session ids), so the Web Crypto implementation is pinned to known outputs, not just to node:crypto.
describe("sha256Hex", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "Zürich, Schweiz — 東京 🗼",
      "b7d825b9ce2e46c0583c9688a98cb91c9fc7d56bb4f18d2ad3df5d26577d587d",
    ],
  ])("hashes %j to its known hex digest", async (text, hex) => {
    expect(await sha256Hex(text)).toBe(hex);
  });

  it("matches node:crypto on a long multi-byte input", async () => {
    const text = "Columbus, OH · São Paulo · Kraków\n".repeat(5000);
    expect(await sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
  });
});
