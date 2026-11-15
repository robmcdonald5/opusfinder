/**
 * SHA-256 on Web Crypto (`crypto.subtle`), so the same code runs in Node and in a Cloudflare Worker.
 * The output is byte-identical to `createHash("sha256").update(text).digest("hex")`; some callers store
 * a prefix of it (location request ids, prompt-cache session ids), so that must not change.
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
