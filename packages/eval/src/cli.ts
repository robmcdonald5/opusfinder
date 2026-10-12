/**
 * Tiny CLI flag reader shared by the eval scripts, so the `--flag value` parsing lives in ONE
 * place instead of a near-identical copy per script. `args` is the already-sliced argv
 * (`process.argv.slice(2)`).
 *
 * Returns the token AFTER `flag`, or undefined if the flag is absent. A flag given with no value
 * (last token, or followed by another `--flag`) throws: callers read undefined as "use the
 * default", and the defaults are the widest runs (every profile, the whole pool), so a forgotten
 * value must not silently become one. Values that legitimately start with "--" aren't used by
 * these scripts.
 */
export function getFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}
