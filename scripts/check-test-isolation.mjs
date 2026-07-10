// Standing guard for the test-project isolation invariant (companion to check-worker-isolation.mjs).
// Phase 3's blocker resolution made "a mock suite can never silently hit the real network" STRUCTURAL:
// every real-network gate lives in a no-MSW `live` Vitest project (`*.live.test.ts`) that the default
// `pnpm test` excludes, while mock suites stay in the always-`onUnhandledRequest:"error"` `integration`
// project. Phase 5a wires this guard into CI so that invariant cannot silently regress.
//
// TWO checks (each fails the run, exit 1):
//   (a) Live-gate marker — every `*.live.test.ts` must carry an EXPLICIT opt-in gate: a `.skipIf(`/`.runIf(`
//       call AND a `process.env.<*LIVE*>` flag read (dot OR bracket access). A bare cred-only gate (e.g.
//       `skipIf(!process.env.DATABASE_URL)`) would fire against REAL infra for anyone with creds in their
//       package `.env`; it has no `*LIVE*` flag, so it fails here — the exact hole the Phase-3 resolution
//       called out. Comments are STRIPPED before the scan, so a documentation comment that quotes the
//       pattern can't satisfy the check on behalf of missing real code.
//   (b) One-project collection (AUTHORITATIVE) — `vitest list --filesOnly` tags every collected file with its
//       project as `[project] path`. A file whose project disagrees with its filename suffix is MISROUTED
//       (this also catches double-collection: e.g. dropping the unit `exclude: **/*.live.test.ts` re-collects
//       a live file MSW-free, so it shows up under `[unit]` too). A `*.test.ts` under a package's `src/` that
//       is collected by NO project is an ORPHAN that silently never runs. This reflects Vitest's REAL
//       include/exclude resolution — a textual config scan is blind to it (mirrors the worker guard's
//       authoritative real-esbuild-graph scan).
// Run: pnpm guard:tests
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TEST_ROOTS = ["packages", "apps"];
const PRUNE_DIRS = new Set(["node_modules", "dist", ".svelte-kit", "coverage"]);
// The vitest projects this guard models. A project reported by `vitest list` that isn't here means the guard
// is stale relative to vitest.config.ts — flagged loudly (see below) rather than mis-classified silently.
const KNOWN_PROJECTS = new Set(["unit", "integration", "live"]);
// The opt-in flag convention: an env var whose name contains LIVE (AUTH_LIVE_TEST, PREFS_LIVE_TEST,
// HN_LIVE_TEST, OUTSCAL_SEED_LIVE), read by dot OR bracket access. Requiring the FLAG — not mere cred
// presence — forces an intentional opt-in on top of any creds a dev's package `.env` might define. Both
// patterns match an actual code construct, and comments are stripped first, so prose can't satisfy them.
const LIVE_FLAG_RE =
  /process\.env(?:\.[A-Z0-9_]*LIVE[A-Z0-9_]*|\[\s*['"][A-Z0-9_]*LIVE[A-Z0-9_]*['"]\s*\])/;
const GATE_RE = /\.(?:skipIf|runIf)\s*\(/;

// The project each suffix MUST route to (see vitest.config.ts project include/exclude).
function expectedProject(path) {
  if (path.endsWith(".live.test.ts")) return "live";
  if (path.endsWith(".integration.test.ts")) return "integration";
  return "unit";
}

// Drop block + line comments so a documentation comment (which may quote `.skipIf(` or a `process.env.<LIVE>`
// example) can't satisfy check (a) in place of the real gate. The `[^:]` guard keeps a `://` in a URL from
// being read as a line-comment start.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

let failures = 0;

// Recursively collect every `*.test.ts` under a dir (posix-normalized), pruning heavy/irrelevant dirs.
function walkTestFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!PRUNE_DIRS.has(entry.name)) walkTestFiles(join(dir, entry.name), out);
    } else if (entry.name.endsWith(".test.ts")) {
      out.push(join(dir, entry.name).replace(/\\/g, "/"));
    }
  }
  return out;
}

// Scope the disk walk to each package/app `src/` — where 100% of the repo's tests live and where the unit
// include glob (`{packages,apps}/*/src/**`) points — so a helper file or a nested layout vitest legitimately
// ignores is never a false orphan.
function packageSrcDirs() {
  const dirs = [];
  for (const root of TEST_ROOTS) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || PRUNE_DIRS.has(entry.name)) continue;
      const src = join(root, entry.name, "src");
      if (existsSync(src)) dirs.push(src);
    }
  }
  return dirs;
}

const allTestFiles = packageSrcDirs().flatMap((d) => walkTestFiles(d));

// ---- Check (a): every *.live.test.ts carries an explicit flag-gated skipIf/runIf marker. ----
for (const file of allTestFiles.filter((f) => f.endsWith(".live.test.ts"))) {
  const code = stripComments(readFileSync(file, "utf8"));
  const missing = [
    !GATE_RE.test(code) && "a skipIf(...)/runIf(...) gate",
    !LIVE_FLAG_RE.test(code) && "a process.env.<*LIVE*> opt-in flag",
  ].filter(Boolean);
  if (missing.length > 0) {
    console.error(
      `FORBIDDEN live gate: ${file} is missing ${missing.join(" and ")}. A *.live.test.ts opens the real ` +
        `network, so it MUST be gated on an explicit opt-in flag — never on cred-presence alone.`,
    );
    failures++;
  }
}

// ---- Check (b): every test file collected by exactly one, correct project (no misroute, no orphan). ----
let listOutput = "";
let listOk = false;
try {
  listOutput = execSync("pnpm exec vitest list --filesOnly", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  listOk = true;
} catch (err) {
  const detail =
    [err?.stderr?.toString(), err?.stdout?.toString()].filter(Boolean).join("\n").trim() ||
    (err instanceof Error ? err.message : String(err));
  console.error(
    `FORBIDDEN: \`vitest list\` failed — test collection is broken (a project config error or an import-time ` +
      `throw in a test file). Fix collection before this guard can verify project isolation.\n${detail}`,
  );
  failures++;
}

// Parse `[project] path` lines → path → Set(projects). Project names may contain hyphens (e.g. a future
// `pool-workers` project), so accept `[a-z][a-z-]*`.
const collectedBy = new Map();
for (const line of listOutput.split(/\r?\n/)) {
  const m = /^\[([a-z][a-z-]*)\]\s+(.+\.test\.ts)$/.exec(line.trim());
  if (!m) continue;
  const [, project, path] = m;
  if (!collectedBy.has(path)) collectedBy.set(path, new Set());
  collectedBy.get(path).add(project);
}

// A collection that succeeds but returns zero files means every include glob matched nothing — a config
// regression the misroute/orphan loops below would otherwise silently pass ("OK — 0 test files").
if (listOk && collectedBy.size === 0 && allTestFiles.length > 0) {
  console.error(
    `FORBIDDEN: \`vitest list\` collected NO files, but ${allTestFiles.length} *.test.ts file(s) exist under ` +
      `packages/apps src/ — the project include globs are matching nothing (a vitest.config.ts regression).`,
  );
  failures++;
}

// Any project vitest reports that this guard doesn't model → the guard is stale; flag it once (and skip its
// files in the misroute loop so they don't also spam as "misrouted to unit").
const unknownProjects = new Set();
for (const projects of collectedBy.values()) {
  for (const p of projects) if (!KNOWN_PROJECTS.has(p)) unknownProjects.add(p);
}
for (const p of [...unknownProjects].sort()) {
  console.error(
    `FORBIDDEN: vitest reported project "${p}", which this guard does not model. After adding a project to ` +
      `vitest.config.ts, extend KNOWN_PROJECTS + expectedProject() in scripts/check-test-isolation.mjs.`,
  );
  failures++;
}

// Misroute (subsumes double-collection: a 2nd project can't match the suffix, so it fires).
for (const [path, projects] of collectedBy) {
  const expected = expectedProject(path);
  for (const project of projects) {
    if (!KNOWN_PROJECTS.has(project)) continue; // already flagged as an unknown project above
    if (project !== expected) {
      console.error(
        `FORBIDDEN misrouted test: ${path} (suffix ⇒ "${expected}" project) was collected by the ` +
          `"${project}" project — the filename suffix and vitest include/exclude globs are out of sync.`,
      );
      failures++;
    }
  }
}

// Orphan: a src `*.test.ts` on disk collected by no project (silently never runs). Only meaningful when
// collection succeeded AND returned files (the empty case is handled above).
if (listOk && collectedBy.size > 0) {
  for (const file of allTestFiles) {
    if (!collectedBy.has(file)) {
      console.error(
        `FORBIDDEN orphan test: ${file} is collected by NO vitest project — it would silently never run. ` +
          `Give it a recognized suffix (.test / .integration.test / .live.test) or fix the include/exclude globs.`,
      );
      failures++;
    }
  }
}

if (failures > 0) {
  console.error(`\nTest-isolation guard FAILED: ${failures} violation(s).`);
  process.exitCode = 1;
} else {
  const byProject = {};
  for (const projects of collectedBy.values()) for (const p of projects) byProject[p] = (byProject[p] ?? 0) + 1;
  const tally = ["unit", "integration", "live"].map((p) => `${byProject[p] ?? 0} ${p}`).join(" / ");
  console.log(
    `Test-isolation guard OK — ${collectedBy.size} test file(s), each in its correct project by suffix ` +
      `(${tally}, all live gates flag-gated); no misrouted or orphan files.`,
  );
}
