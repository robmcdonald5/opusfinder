// Shared by the structural guards (check-test-isolation.mjs, check-worker-isolation.mjs): drop block and
// line comments so a documentation comment that quotes a pattern (`.skipIf(`, `process.env.<LIVE>`,
// `process`, `@opusfinder/db`) can neither satisfy nor trip a check on behalf of real code. The `[^:]`
// guard keeps a `://` in a URL from being read as a line-comment start. Deliberately simple — it is not a
// tokenizer (a `//` inside a string literal is stripped too), which errs toward fewer matches in code that
// only names things in strings, never toward missing an import.
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
