import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 0 pilot — singleton isolation (R4). provider.ts memoizes the Anthropic provider in a module-scope
// `let provider`, and env.ts reads the key lazily via requireEnv. This proves the two leak-prevention
// mechanisms compose under esbuild + verbatimModuleSyntax/isolatedModules:
//   1. within one module instance the provider is built exactly ONCE (memoized);
//   2. vi.resetModules() yields a FRESH module registry that re-reads the (re-stubbed) key — the
//      per-process isolation the old tsx scripts got for free, now reproduced inside a worker.
//
// `@ai-sdk/anthropic` is mocked so the test never constructs a real client or needs a real key. The mock
// records each apiKey it is constructed with in a hoisted array that survives vi.resetModules() (it lives
// in the test file, not the mocked module).
const recorder = vi.hoisted(() => ({ keys: [] as string[] }));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: (opts: { apiKey: string }) => {
    recorder.keys.push(opts.apiKey);
    return (modelId: string) => ({ modelId });
  },
}));

beforeEach(() => {
  recorder.keys.length = 0;
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getProvider memoization (R4 singleton isolation)", () => {
  it("constructs the Anthropic provider exactly once and reuses it across resolveModel calls", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-pilot-key");

    const { resolveModel } = await import("./provider");
    resolveModel("haiku");
    resolveModel("sonnet");

    expect(recorder.keys).toEqual(["sk-ant-pilot-key"]); // built once, reused on the second resolution
  });

  it("re-reads the key after vi.resetModules() gives a fresh module registry", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-first");
    const first = await import("./provider");
    first.resolveModel("haiku");
    expect(recorder.keys).toEqual(["sk-ant-first"]);

    // Fresh registry → provider memo is cleared → the rotated key is picked up.
    vi.resetModules();
    recorder.keys.length = 0;
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-second");
    const second = await import("./provider");
    second.resolveModel("haiku");
    expect(recorder.keys).toEqual(["sk-ant-second"]);
  });
});
