/** Titles are capped too: a huge one from a hostile board is paid for in every request it rides. */
export const TITLE_CHARS = 300;

/**
 * Prepare third-party posting text for a `<job>` block in a prompt. Swaps the `<` of any `<job` /
 * `</job` for `‹` so a posting can't close its own block or forge another posting (deleting it
 * instead would turn `<</job>` into a real tag, and would shorten the text past the cut below).
 * Then cuts to `max` UTF-16 units + "…" without splitting a surrogate pair: a lone surrogate (half
 * an emoji) is not valid Unicode, and a strict JSON parser rejects the whole request carrying it.
 */
export function jobText(text: string, max: number): string {
  const s = text.replace(/<(?=\/?job)/gi, "‹");
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return `${s.slice(0, end)}…`;
}
