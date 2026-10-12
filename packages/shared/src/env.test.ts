import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadPackageEnv } from "./env";

let root: string;

/** The `import.meta.url` a module in `<root>/<pkg>/src/` would pass. */
const moduleIn = (pkg: string): string => pathToFileURL(join(root, pkg, "src", "env.ts")).href;

describe("loadPackageEnv", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "load-package-env-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("skips blank keys, so one package's blank template line can't hide another's value", () => {
    vi.stubEnv("LOAD_ENV_TEST_KEY", undefined);
    vi.stubEnv("LOAD_ENV_TEST_SHELL", "from-shell");
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
    writeFileSync(join(root, "a", ".env"), "LOAD_ENV_TEST_KEY=\nLOAD_ENV_TEST_SHELL=from-a\n");
    writeFileSync(join(root, "b", ".env"), "LOAD_ENV_TEST_KEY=from-b\n");

    loadPackageEnv(moduleIn("a"));
    loadPackageEnv(moduleIn("b"));

    expect(process.env.LOAD_ENV_TEST_KEY).toBe("from-b");
    expect(process.env.LOAD_ENV_TEST_SHELL).toBe("from-shell");
  });

  it("warns when the .env exists but can't be read", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mkdirSync(join(root, "c", ".env"), { recursive: true }); // a directory fails the read on every OS

    loadPackageEnv(moduleIn("c"));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(join(root, "c", ".env")));
  });
});
