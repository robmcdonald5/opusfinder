// Standing guard for the Worker-isolation invariant: server-only subsystems must NEVER enter the
// apps/scrapers Cloudflare Worker bundle. Phase 9.5: Better Auth (+ the neon-serverless auth client)
// crashes at import under `nodejs_compat` (#6665). Phase 10: the Inngest digest pipeline is Node-hosted
// and drags in @anthropic-ai/sdk + the llm/db env loaders — it must stay out of the scraper Worker (and
// the two concerns stay separate). Phase 11: email (@opusfinder/email + the resend SDK) is a trusted
// server-runtime concern, same posture.
//
// THREE scans (each fails the run, exit 1):
//   1. Direct source scan  — forbidden import string in apps/scrapers/src/*.ts (catches a direct import
//      AND a stray mention in a comment/string; cheap defense-in-depth).
//   2. Direct dep scan      — apps/scrapers/package.json must not DECLARE a forbidden package.
//   3. Transitive bundle scan (AUTHORITATIVE) — esbuild bundles the Worker entry exactly as wrangler does
//      (workerd/worker/browser conditions, browser platform) and we walk the resolved module graph from
//      the metafile. This is the only scan that catches a forbidden package pulled in THROUGH a workspace
//      package (e.g. @opusfinder/db/repos starting to import @opusfinder/rerank) — the Worker's real risk
//      surface, which scans 1+2 are blind to. A node:* builtin leak also surfaces here as a browser-platform
//      BUILD FAILURE (the clean graph bundles, so any failure is a real signal).
// Run: pnpm guard:worker
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = "apps/scrapers/src";
const ENTRY = "apps/scrapers/src/index.ts";

const FORBIDDEN_IMPORTS = [
  "better-auth",
  "@opusfinder/auth",
  "@opusfinder/profiles",
  "@opusfinder/inngest",
  "@opusfinder/llm",
  "@opusfinder/rerank",
  "@opusfinder/email",
  "@anthropic-ai/sdk",
  "resend",
  "inngest",
  "neon-serverless",
  "auth-client",
];
const FORBIDDEN_DEPS = [
  "@opusfinder/auth",
  "@opusfinder/profiles",
  "@opusfinder/inngest",
  "@opusfinder/llm",
  "@opusfinder/rerank",
  "@opusfinder/email",
  "@anthropic-ai/sdk",
  "resend",
  "better-auth",
  "inngest",
  // dotenv loads env from disk via node:fs — it has no place in the Worker, whose env is bound at the
  // edge. Forbidden as a direct dep (a transitive pull is also caught by the browser-platform build).
  "dotenv",
];
// Path fragments that must NOT appear among the bundle's resolved inputs. First-party server-only
// packages by their source dir, plus the Node/server-only third-party SDKs by their node_modules path
// (forward-slash; esbuild normalizes metafile keys to posix on every OS).
const FORBIDDEN_BUNDLE_PATHS = [
  "packages/auth/",
  "packages/profiles/",
  "packages/inngest/",
  "packages/llm/",
  "packages/rerank/",
  "packages/email/",
  "/@anthropic-ai/",
  "/resend/",
  "/better-auth/",
  "/inngest/",
  "/dotenv/",
];

let failures = 0;

// 1. Direct source scan.
const files = readdirSync(SRC, { recursive: true })
  .map((f) => join(SRC, f.toString()))
  .filter((f) => f.endsWith(".ts"));
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const needle of FORBIDDEN_IMPORTS) {
    if (text.includes(needle)) {
      console.error(`FORBIDDEN import "${needle}" in ${file}`);
      failures++;
    }
  }
}

// 2. Direct dependency scan.
const pkg = JSON.parse(readFileSync("apps/scrapers/package.json", "utf8"));
const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
for (const bad of FORBIDDEN_DEPS) {
  if (deps.includes(bad)) {
    console.error(`FORBIDDEN dependency "${bad}" in apps/scrapers/package.json`);
    failures++;
  }
}

// 3. Transitive bundle scan — the authoritative check. esbuild resolves the SAME module graph wrangler
// bundles (workerd/worker/browser export conditions, browser platform), so a forbidden package reachable
// through ANY workspace edge shows up as a resolved input. A node:* builtin leak fails the browser build.
let bundleInputCount = 0;
try {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    metafile: true,
    platform: "browser",
    format: "esm",
    conditions: ["workerd", "worker", "browser"],
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs);
  bundleInputCount = inputs.length;
  for (const input of inputs) {
    const normalized = input.replace(/\\/g, "/");
    for (const bad of FORBIDDEN_BUNDLE_PATHS) {
      if (normalized.includes(bad)) {
        console.error(`FORBIDDEN module in Worker bundle graph: ${input} (matched "${bad}")`);
        failures++;
      }
    }
  }
} catch (err) {
  // The clean graph bundles cleanly under the browser platform, so a build failure is itself a violation
  // signal — most often a node:* builtin (or an otherwise-unresolvable server dep) leaking into the graph.
  console.error(
    `FORBIDDEN: the Worker entry failed to bundle for the edge runtime — a node:* builtin or server-only ` +
      `dependency likely leaked into the import graph.\n${err instanceof Error ? err.message : String(err)}`,
  );
  failures++;
}

if (failures > 0) {
  console.error(
    `\nWorker-isolation guard FAILED: ${failures} violation(s). Auth (Better Auth, #6665), the Inngest digest pipeline, and email (resend) must stay out of the scrapers Worker.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `Worker-isolation guard OK — ${files.length} source file(s) scanned + ${deps.length} direct dep(s) checked + ` +
      `transitive bundle graph clean (${bundleInputCount} resolved inputs, browser/workerd conditions). ` +
      `No auth / neon-serverless / inngest / email / anthropic leakage reachable from the Worker entry.`,
  );
}
