// Test-only ambient types for the Worker-graph TEST typecheck (tsconfig.test.json includes this file; the
// shippable tsconfig.json does not). Vitest (Vite) resolves a `?raw` import to the file's text — that is
// how dispatch.test.ts reads wrangler.toml, since these Workers types have no node:fs. The Workers runtime
// types know nothing about the suffix, so declare it here.
declare module "*?raw" {
  const text: string;
  export default text;
}
