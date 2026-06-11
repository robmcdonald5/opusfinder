// Standing guard for the Worker-isolation invariant: server-only subsystems must NEVER enter the
// apps/scrapers Cloudflare Worker bundle. Phase 9.5: Better Auth (+ the neon-serverless auth client)
// crashes at import under `nodejs_compat` (#6665). Phase 10: the Inngest digest pipeline is Node-hosted
// and drags in @anthropic-ai/sdk + the llm/db env loaders — it must stay out of the scraper Worker (and
// the two concerns stay separate). Phase 11: email (@opusfinder/email + the resend SDK) is a trusted
// server-runtime concern, same posture. Fails (exit 1) if a forbidden import appears in the Worker
// source, OR if the Worker's package.json depends on one. Cross-platform (plain node + fs, no shell
// `grep`). Run: pnpm guard:worker
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = "apps/scrapers/src";
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
];

let failures = 0;

// 1. Source scan — no forbidden import string anywhere under the Worker source.
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

// 2. Dependency scan — the Worker must not depend on a package that drags Better Auth into its graph.
const pkg = JSON.parse(readFileSync("apps/scrapers/package.json", "utf8"));
const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
for (const bad of FORBIDDEN_DEPS) {
  if (deps.includes(bad)) {
    console.error(`FORBIDDEN dependency "${bad}" in apps/scrapers/package.json`);
    failures++;
  }
}

if (failures > 0) {
  console.error(
    `\nWorker-isolation guard FAILED: ${failures} violation(s). Auth (Better Auth, #6665), the Inngest digest pipeline, and email (resend) must stay out of the scrapers Worker.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `Worker-isolation guard OK — ${files.length} Worker source file(s) scanned; no auth / neon-serverless / inngest / email leakage.`,
  );
}
