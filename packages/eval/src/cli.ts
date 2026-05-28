/**
 * Tiny CLI flag reader shared by the eval scripts (eval, compare, export-candidates), so the
 * `--flag value` parsing lives in ONE place instead of a near-identical copy per script. `args`
 * is the already-sliced argv (`process.argv.slice(2)`).
 *
 * Returns the token AFTER `flag`, or undefined if the flag is absent, is the last token with no
 * value, OR is followed by another `--flag`. That last guard stops a forgotten value from
 * silently swallowing the next option as its argument (e.g. `--embedder --ranker x` must not set
 * embedder to "--ranker"). Values that legitimately start with "--" aren't used by these scripts.
 */
export function getFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  const value = args[i + 1] as string;
  return value.startsWith("--") ? undefined : value;
}
