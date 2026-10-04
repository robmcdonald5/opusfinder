import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { configPath, loadConfig, type ConfigDeps } from "./config";

// The CLI holds the agent's Access service token, so beyond "find the config" the load-bearing rules are:
// env beats file per field, https-only, and the secret never appears in an error or warning.

const SECRET = "s3cr3t-client-secret-value-0123456789abcdef";
const HOME = join("/home", "agent");
const DEFAULT_PATH = join(HOME, ".config", "opusfinder-agent", "ctl.json");

function deps(opts: {
  env?: Record<string, string>;
  files?: Record<string, string>;
  mode?: number | null;
}): ConfigDeps {
  return {
    env: opts.env ?? {},
    home: HOME,
    readFile: (path) => opts.files?.[path] ?? null,
    fileMode: (path) => (opts.files?.[path] !== undefined ? (opts.mode ?? 0o100600) : null),
  };
}

const goodFile = JSON.stringify({
  url: "https://opusfinder-control.example.workers.dev/",
  clientId: "abc.access",
  clientSecret: SECRET,
});

describe("configPath", () => {
  it("defaults to ~/.config/opusfinder-agent/ctl.json, honouring XDG_CONFIG_HOME and an explicit override", () => {
    expect(configPath({ env: {}, home: HOME })).toBe(DEFAULT_PATH);
    expect(configPath({ env: { XDG_CONFIG_HOME: "/xdg" }, home: HOME })).toBe(
      join("/xdg", "opusfinder-agent", "ctl.json"),
    );
    expect(configPath({ env: { OPUSFINDER_CTL_CONFIG: "/elsewhere.json" }, home: HOME })).toBe(
      "/elsewhere.json",
    );
  });
});

describe("loadConfig", () => {
  it("reads the file and trims the URL's trailing slash", () => {
    const r = loadConfig(deps({ files: { [DEFAULT_PATH]: goodFile } }));
    expect(r).toEqual({
      ok: true,
      path: DEFAULT_PATH,
      warnings: [],
      config: {
        url: "https://opusfinder-control.example.workers.dev",
        clientId: "abc.access",
        clientSecret: SECRET,
      },
    });
  });

  it("lets env vars override the file field by field, or stand alone", () => {
    const r = loadConfig(
      deps({
        files: { [DEFAULT_PATH]: goodFile },
        env: { OPUSFINDER_CTL_CLIENT_ID: "env.access" },
      }),
    );
    expect(r.ok && r.config.clientId).toBe("env.access");
    expect(r.ok && r.config.clientSecret).toBe(SECRET);
    const envOnly = loadConfig(
      deps({
        env: {
          OPUSFINDER_CTL_URL: "http://localhost:8787",
          OPUSFINDER_CTL_CLIENT_ID: "a",
          OPUSFINDER_CTL_CLIENT_SECRET: SECRET,
        },
      }),
    );
    expect(envOnly.ok && envOnly.config.url).toBe("http://localhost:8787");
  });

  it("names what is missing and where it looked — never a value", () => {
    const r = loadConfig(deps({ env: { OPUSFINDER_CTL_CLIENT_SECRET: SECRET } }));
    expect(r.ok).toBe(false);
    const error = r.ok ? "" : r.error;
    expect(error).toContain("missing url, clientId");
    expect(error).toContain("(not found)");
    expect(error).toContain("OPUSFINDER_CTL_URL / OPUSFINDER_CTL_CLIENT_ID");
    expect(error).not.toContain(SECRET);
  });

  it("refuses a malformed file without echoing its contents", () => {
    const broken = `{"clientSecret": "${SECRET}",`;
    const r = loadConfig(deps({ files: { [DEFAULT_PATH]: broken } }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/not a JSON object \(\d+ bytes\)/);
    expect(r.ok ? "" : r.error).not.toContain(SECRET);
  });

  it.each([
    ["plain http to a remote host", "http://opusfinder-control.example.workers.dev"],
    ["a query string", "https://x.example.com/?a=1"],
    ["not a URL", "opusfinder-control"],
  ])("refuses %s as the url", (_label, url) => {
    const r = loadConfig(
      deps({
        env: {
          OPUSFINDER_CTL_URL: url,
          OPUSFINDER_CTL_CLIENT_ID: "a",
          OPUSFINDER_CTL_CLIENT_SECRET: SECRET,
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).not.toContain(SECRET);
  });

  it("warns when the credential file is readable by others", () => {
    const loose = loadConfig(deps({ files: { [DEFAULT_PATH]: goodFile }, mode: 0o100644 }));
    expect(loose.ok && loose.warnings).toEqual([
      `${DEFAULT_PATH} is readable by other users (mode 644); run: chmod 600 ${DEFAULT_PATH}`,
    ]);
    const windows = loadConfig({
      ...deps({ files: { [DEFAULT_PATH]: goodFile } }),
      fileMode: () => null,
    });
    expect(windows.ok && windows.warnings).toEqual([]);
  });
});
