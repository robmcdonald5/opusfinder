import { execFileSync } from "node:child_process";

import { runScript } from "@opusfinder/shared/script";

import { fixSha256, readFixes, type FixFile } from "../src/fixes";

// The secret-free PR check for packages/db/fixes (`pnpm guard:fixes`, run by ci.yml): file names and numbering,
// the SQL lint (no transaction control, DDL, privilege statements or dynamic SQL), and no edit, rename or
// deletion of a fix that is already on main. Merged fixes are compared against FIXES_BASE_REF (default
// origin/main), which CI fetches first; outside CI a missing base ref only skips that comparison.

const FIXES_PATH = "packages/db/fixes"; // repo-relative, for git

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Problems for each fix on the base ref that is missing or different here. */
function mergedFixProblems(fixes: readonly FixFile[]): string[] {
  const base = process.env.FIXES_BASE_REF || "origin/main";
  try {
    git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  } catch {
    if (process.env.CI) {
      return [`base ref ${base} not found: fetch it so merged fixes can be compared`];
    }
    console.warn(`Skipping the merged-fix comparison: ${base} not found locally.`);
    return [];
  }
  const problems: string[] = [];
  const current = new Map(fixes.map((f) => [f.name, f.sha256]));
  const merged = git(["ls-tree", "--full-tree", "--name-only", base, `${FIXES_PATH}/`])
    .split("\n")
    .filter((p) => p.endsWith(".sql"));
  for (const path of merged) {
    const name = path.slice(FIXES_PATH.length + 1);
    const sha = current.get(name);
    if (sha === undefined) {
      problems.push(`${name}: on ${base} but deleted or renamed here; fixes are append-only`);
    } else if (sha !== fixSha256(git(["show", `${base}:${path}`]))) {
      problems.push(`${name}: edited after merge to ${base}; write a new fix instead`);
    }
  }
  return problems;
}

await runScript("Fix-file check", () => {
  const { fixes, problems } = readFixes();
  problems.push(...mergedFixProblems(fixes));
  if (problems.length > 0) throw new Error(`\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  console.log(`Fix files OK (${fixes.length}).`);
});
