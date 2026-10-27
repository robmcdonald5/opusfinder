import { execFileSync } from "node:child_process";

/** `gh` with `input` on stdin; its stderr goes to the terminal. */
export function gh(args: string[], input?: string): string {
  return execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] });
}

/** The repository `gh` targets from this checkout, as owner/name. */
export function currentRepo(): string {
  return gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
}

/** Create the environment if missing and allow deployments from `main` only. */
export function ensureEnvironment(repo: string, environment: string): void {
  const base = `repos/${repo}/environments/${environment}`;
  const policy = {
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  gh(["api", "-X", "PUT", base, "--input", "-"], JSON.stringify(policy));
  const rules = gh([
    "api",
    `${base}/deployment-branch-policies`,
    "--jq",
    '.branch_policies[] | "\\(.type):\\(.name)"',
  ])
    .split("\n")
    .filter(Boolean);
  const others = rules.filter((r) => r !== "branch:main");
  if (others.length > 0) {
    throw new Error(
      `environment ${environment} also allows ${others.join(", ")}; remove them under Settings → Environments, then re-run`,
    );
  }
  if (rules.length === 0) {
    gh([
      "api",
      "-X",
      "POST",
      `${base}/deployment-branch-policies`,
      "-f",
      "name=main",
      "-f",
      "type=branch",
    ]);
  }
}

/** Set an Environment secret from stdin, so the value never reaches a command line. */
export function setEnvironmentSecret(
  repo: string,
  environment: string,
  name: string,
  value: string,
): void {
  gh(["secret", "set", name, "--env", environment, "--repo", repo], value);
}
