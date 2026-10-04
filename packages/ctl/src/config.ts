import { join } from "node:path";

/**
 * `pnpm ctl` configuration: where the control Worker lives and the Access SERVICE TOKEN the CLI presents
 * (the agent credential, §11.1). Read from a JSON file the agent sandbox may read —
 * `~/.config/opusfinder-agent/ctl.json` by default, deliberately OUTSIDE the sandbox-denied
 * `~/.config/opusfinder` that holds the prod Neon credential — with env vars taking precedence per field.
 *
 * The client secret is a credential: it is never printed, echoed in an error or logged. Diagnostics name
 * the field and where it was looked for, and at most say "present (N chars)" (secrets-not-in-errors).
 */

export const ENV_VARS = {
  url: "OPUSFINDER_CTL_URL",
  clientId: "OPUSFINDER_CTL_CLIENT_ID",
  clientSecret: "OPUSFINDER_CTL_CLIENT_SECRET",
  file: "OPUSFINDER_CTL_CONFIG",
} as const;

export interface CtlConfig {
  /** e.g. https://opusfinder-control.<subdomain>.workers.dev — no trailing slash. */
  url: string;
  clientId: string;
  clientSecret: string;
}

export interface ConfigDeps {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** File contents, or null when the file doesn't exist. */
  readFile: (path: string) => string | null;
  /** POSIX permission bits, or null where they don't apply (Windows) or the file is absent. */
  fileMode: (path: string) => number | null;
}

export type ConfigResult =
  | { ok: true; config: CtlConfig; path: string; warnings: string[] }
  | { ok: false; error: string };

export function configPath(deps: Pick<ConfigDeps, "env" | "home">): string {
  const explicit = deps.env[ENV_VARS.file];
  if (explicit) return explicit;
  const base = deps.env.XDG_CONFIG_HOME || join(deps.home, ".config");
  return join(base, "opusfinder-agent", "ctl.json");
}

/** https only — the service token rides in request headers — except a loopback URL for `wrangler dev`. */
function validUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
  if (u.search || u.hash) return null;
  return u.toString().replace(/\/+$/, "");
}

export function loadConfig(deps: ConfigDeps): ConfigResult {
  const path = configPath(deps);
  const warnings: string[] = [];
  let file: Partial<Record<keyof CtlConfig, unknown>> = {};
  // Never echo the content: it holds the client secret.
  let corrupt: string | null = null;
  const text = deps.readFile(path);
  if (text !== null) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        throw new Error("not an object");
      file = parsed as typeof file;
    } catch {
      corrupt = `${path} is not a JSON object (${text.length} bytes); expected {"url", "clientId", "clientSecret"}`;
    }
    const mode = deps.fileMode(path);
    if (mode !== null && (mode & 0o077) !== 0) {
      warnings.push(
        `${path} is readable by other users (mode ${(mode & 0o777).toString(8)}); run: chmod 600 ${path}`,
      );
    }
  }

  const pick = (key: keyof CtlConfig): string | undefined => {
    const fromEnv = deps.env[ENV_VARS[key]];
    if (fromEnv) return fromEnv.trim();
    const fromFile = file[key];
    return typeof fromFile === "string" && fromFile.trim() ? fromFile.trim() : undefined;
  };

  const missing = (["url", "clientId", "clientSecret"] as const).filter((k) => !pick(k));
  // Env vars win per field, so a broken file only matters for the fields the env doesn't supply.
  if (corrupt !== null) {
    if (missing.length > 0) return { ok: false, error: corrupt };
    warnings.push(`${corrupt} — ignored: every field came from the environment`);
  }
  if (missing.length > 0) {
    const where = text === null ? `${path} (not found)` : path;
    return {
      ok: false,
      error:
        `missing ${missing.join(", ")} — set them in ${where} or via ` +
        missing.map((k) => ENV_VARS[k]).join(" / "),
    };
  }
  const url = validUrl(pick("url") as string);
  if (!url)
    return {
      ok: false,
      error: "url must be an https:// origin (or http://localhost for wrangler dev)",
    };
  return {
    ok: true,
    path,
    warnings,
    config: {
      url,
      clientId: pick("clientId") as string,
      clientSecret: pick("clientSecret") as string,
    },
  };
}
