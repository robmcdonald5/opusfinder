import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Workspace packages ship RAW .ts (exports → ./src/*.ts, no build step). Vitest MUST bundle them, not
// externalize — mirrors apps/web/vite.config.ts ssr.noExternal. Without this the first cross-package
// import (e.g. @opusfinder/shared from @opusfinder/db) fails to resolve at test time.
const INLINE_WORKSPACE = [/^@opusfinder\//];

export default defineConfig({
  resolve: {
    // Shared test-support helpers (PGlite fixture, MSW handlers) live at the repo-root test/ dir;
    // @test/* keeps cross-package test imports stable instead of ../../../../ relative chains. The same
    // mapping is mirrored in tsconfig.test.json for type resolution.
    alias: { "@test": fileURLToPath(new URL("./test", import.meta.url)) },
  },
  test: {
    server: { deps: { inline: INLINE_WORKSPACE } },
    // Windows teardown: NEVER --forceExit — it re-arms the libuv UV_HANDLE_CLOSING crash (exit
    // 3221226505). Instead give afterAll close hooks room to drain socket/WASM handles (PGlite
    // client.close(), neon Pool end(), MSW server.close()) so the process exits cleanly on its own.
    teardownTimeout: 15_000,
    projects: [
      {
        extends: true, // inherit server.deps.inline + teardownTimeout
        test: {
          name: "unit",
          environment: "node",
          isolate: true, // fresh module registry per file → memoized SDK singletons can't leak across files
          include: ["{packages,apps}/*/src/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          isolate: true,
          include: ["{packages,apps}/*/**/*.integration.test.ts"],
          setupFiles: ["./test/setup/msw.ts"], // shared MSW server lifecycle
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["{packages,apps}/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts", // also covers *.integration.test.ts
        "**/scripts/**", // CLI entrypoints (runScript wrappers, manual tools) — not under test
        "**/test/**", // fixtures, setup, helpers
        "**/drizzle/**",
        "**/*.d.ts",
      ],
      // CAVEAT: v8 coverage does NOT work under workerd. A future @cloudflare/vitest-pool-workers
      // project (a true in-isolate scrapers Worker suite) must use provider:"istanbul" and merge
      // separately. The scrapers Worker is tested today as pure dispatch/cursor logic in the node pool.
    },
  },
});
