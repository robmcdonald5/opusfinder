import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@opusfinder/db", () => ({ createDb: vi.fn(() => ({})) }));
vi.mock("@opusfinder/db/env", () => ({ getDatabaseUrl: vi.fn(() => "postgres://stub") }));
vi.mock("@opusfinder/email", () => ({}));
vi.mock("@opusfinder/llm", () => ({}));

import { buildDigestDeps } from "./deps";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildDigestDeps", () => {
  // The Worker reads the same switch (dispatch.test.ts); the two runtimes must flip together.
  it("enforces the 410 close only when LIFECYCLE_CLOSE_ENFORCE=enforce", () => {
    vi.stubEnv("LIFECYCLE_CLOSE_ENFORCE", "enforce");
    expect(buildDigestDeps().enforceLifecycle).toBe(true);

    vi.stubEnv("LIFECYCLE_CLOSE_ENFORCE", "shadow");
    expect(buildDigestDeps().enforceLifecycle).toBe(false);

    vi.stubEnv("LIFECYCLE_CLOSE_ENFORCE", undefined);
    expect(buildDigestDeps().enforceLifecycle).toBe(false);
  });
});
