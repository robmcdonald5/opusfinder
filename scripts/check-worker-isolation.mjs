// Standing guard for the Worker-isolation invariant: server-only subsystems must NEVER enter a Cloudflare
// Worker bundle. Phase 9.5: Better Auth (+ the neon-serverless auth client) crashes at import under
// `nodejs_compat` (#6665). Phase 10: the Inngest digest pipeline is Node-hosted and drags in
// @anthropic-ai/sdk + the llm/db env loaders — it must stay out of the scraper Worker (and the two concerns
// stay separate). Phase 11: email (@opusfinder/email + the resend SDK) is a trusted server-runtime concern,
// same posture. Control plane slice 1: the control Worker (apps/control) and the pure registry package it
// is built on (packages/control) — the control plane must never be able to wake Neon (C4) and the registry
// will also be imported by the scrapers Worker, so both are held to an ALLOW-list, not just a deny-list.
//
// Per Worker (scrapers, control), THREE scans (each fails the run, exit 1):
//   1. Direct source scan  — forbidden import string in the Worker's src/*.ts (catches a direct import
//      AND a stray mention in a comment/string; cheap defense-in-depth). The control Worker's
//      *.test.ts files are node-side Miniflare harnesses that never ship, so they are not scanned.
//   2. Direct dep scan      — the Worker's package.json must not DECLARE a forbidden package.
//   3. Transitive bundle scan (AUTHORITATIVE) — esbuild bundles the Worker entry exactly as wrangler does
//      (workerd/worker/browser conditions, browser platform) and we walk the resolved module graph from
//      the metafile. This is the only scan that catches a forbidden package pulled in THROUGH a workspace
//      package (e.g. @opusfinder/db/repos starting to import @opusfinder/rerank) — the Worker's real risk
//      surface, which scans 1+2 are blind to. A node:* builtin leak also surfaces here as a browser-platform
//      BUILD FAILURE (the clean graph bundles, so any failure is a real signal). The scrapers Worker is
//      checked against a deny-list of paths; the control Worker against an ALLOW-list (its own src + the
//      pure registry, nothing from node_modules at all).
// Plus the PURE-PACKAGE check for packages/control (the registry every Worker will share): no declared
// dependencies, no `process` / Buffer / require / __dirname / node:* / workspace import in its non-test
// source (comments stripped), and a standalone browser-platform bundle whose inputs are only its own src.
// Type-only Node references (erased before bundling) are caught separately by apps/control's
// node-types-free tsconfig, which compiles packages/control through its import graph.
// Run: pnpm guard:worker
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

const WORKERS = [
  {
    name: "scrapers",
    src: "apps/scrapers/src",
    entry: "apps/scrapers/src/index.ts",
    pkg: "apps/scrapers/package.json",
    scanTests: true,
    forbiddenImports: FORBIDDEN_IMPORTS,
    forbiddenDeps: FORBIDDEN_DEPS,
    forbiddenBundlePaths: FORBIDDEN_BUNDLE_PATHS,
  },
  {
    // The control plane holds no Neon credential and must not be able to import one: @opusfinder/db is
    // forbidden on top of the scrapers list, and the bundle may contain nothing but these two source dirs.
    name: "control",
    src: "apps/control/src",
    entry: "apps/control/src/index.ts",
    pkg: "apps/control/package.json",
    scanTests: false,
    forbiddenImports: [...FORBIDDEN_IMPORTS, "@opusfinder/db"],
    forbiddenDeps: [...FORBIDDEN_DEPS, "@opusfinder/db"],
    allowedBundlePrefixes: ["apps/control/src/", "packages/control/src/"],
    external: ["cloudflare:workers"],
  },
];

const PURE_PACKAGE = {
  name: "packages/control",
  src: "packages/control/src",
  entry: "packages/control/src/index.ts",
  pkg: "packages/control/package.json",
  allowedBundlePrefixes: ["packages/control/src/"],
  // Matched against comment-stripped source (so prose may name what it forbids).
  forbiddenPatterns: [
    [/\bprocess\b/, "`process` (no env reads: values come from the store, not the environment)"],
    [/\bBuffer\b/, "Buffer (a Node global)"],
    [/\brequire\s*\(/, "require()"],
    [/\b__dirname\b|\b__filename\b/, "__dirname/__filename"],
    [/["']node:/, "a node:* import"],
    [/["']@opusfinder\//, "a workspace import (@opusfinder/db above all: the H1 landmine)"],
  ],
};

let failures = 0;
const summaries = [];

// Same comment stripper as check-test-isolation.mjs: the `[^:]` guard keeps a `://` in a URL from being
// read as a line-comment start.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function sourceFiles(dir, includeTests) {
  return readdirSync(dir, { recursive: true })
    .map((f) => join(dir, f.toString()))
    .filter((f) => f.endsWith(".ts") && (includeTests || !f.endsWith(".test.ts")));
}

async function bundleInputs(entry, external = []) {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: "browser",
    format: "esm",
    conditions: ["workerd", "worker", "browser"],
    external,
    logLevel: "silent",
  });
  return Object.keys(result.metafile.inputs).map((i) => i.replace(/\\/g, "/"));
}

function checkInputs(label, inputs, { forbiddenBundlePaths = [], allowedBundlePrefixes }) {
  for (const input of inputs) {
    for (const bad of forbiddenBundlePaths) {
      if (input.includes(bad)) {
        console.error(`FORBIDDEN module in ${label} bundle graph: ${input} (matched "${bad}")`);
        failures++;
      }
    }
    if (allowedBundlePrefixes && !allowedBundlePrefixes.some((p) => input.startsWith(p))) {
      console.error(
        `FORBIDDEN module in ${label} bundle graph: ${input} — only ${allowedBundlePrefixes.join(" + ")} may be bundled`,
      );
      failures++;
    }
  }
}

function bundleFailure(label, err) {
  // The clean graph bundles cleanly under the browser platform, so a build failure is itself a violation
  // signal — most often a node:* builtin (or an otherwise-unresolvable server dep) leaking into the graph.
  console.error(
    `FORBIDDEN: the ${label} entry failed to bundle for the edge runtime — a node:* builtin or server-only ` +
      `dependency likely leaked into the import graph.\n${err instanceof Error ? err.message : String(err)}`,
  );
  failures++;
}

for (const worker of WORKERS) {
  const label = `${worker.name} Worker`;

  // 1. Direct source scan.
  const files = sourceFiles(worker.src, worker.scanTests);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const needle of worker.forbiddenImports) {
      if (text.includes(needle)) {
        console.error(`FORBIDDEN import "${needle}" in ${file}`);
        failures++;
      }
    }
  }

  // 2. Direct dependency scan.
  const pkg = JSON.parse(readFileSync(worker.pkg, "utf8"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const bad of worker.forbiddenDeps) {
    if (deps.includes(bad)) {
      console.error(`FORBIDDEN dependency "${bad}" in ${worker.pkg}`);
      failures++;
    }
  }

  // 3. Transitive bundle scan — the authoritative check.
  let inputs = [];
  try {
    inputs = await bundleInputs(worker.entry, worker.external);
    checkInputs(label, inputs, worker);
  } catch (err) {
    bundleFailure(label, err);
  }
  summaries.push(
    `${worker.name}: ${files.length} source file(s) + ${deps.length} dep(s) + ${inputs.length} bundle inputs`,
  );
}

// The pure registry package.
{
  const p = PURE_PACKAGE;
  const pkg = JSON.parse(readFileSync(p.pkg, "utf8"));
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const declared = Object.keys(pkg[field] ?? {});
    if (declared.length > 0) {
      console.error(
        `FORBIDDEN: ${p.pkg} declares ${field} (${declared.join(", ")}) — ${p.name} must stay a dependency-free leaf`,
      );
      failures++;
    }
  }
  const files = sourceFiles(p.src, false);
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const [pattern, what] of p.forbiddenPatterns) {
      if (pattern.test(code)) {
        console.error(
          `FORBIDDEN in ${file}: ${what} — ${p.name} must stay pure, Worker-safe TypeScript`,
        );
        failures++;
      }
    }
  }
  let inputs = [];
  try {
    inputs = await bundleInputs(p.entry);
    checkInputs(p.name, inputs, p);
  } catch (err) {
    bundleFailure(p.name, err);
  }
  summaries.push(
    `${p.name}: ${files.length} pure source file(s), ${inputs.length} bundle inputs, no deps`,
  );
}

if (failures > 0) {
  console.error(
    `\nWorker-isolation guard FAILED: ${failures} violation(s). Auth (Better Auth, #6665), the Inngest digest pipeline, and email (resend) must stay out of the Workers; the control Worker may bundle only its src + packages/control, which must stay pure.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `Worker-isolation guard OK — ${summaries.join("; ")} (browser/workerd conditions). No auth / neon-serverless / ` +
      `inngest / email / anthropic leakage reachable from either Worker entry; the control Worker bundles only its ` +
      `own src + the pure registry.`,
  );
}
