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
          // MANDATORY: a *.live.test.ts under src/ ends in .test.ts, so it would otherwise be
          // double-collected here (MSW-free) on top of the `live` project — exclude BOTH suffixes.
          exclude: ["**/*.integration.test.ts", "**/*.live.test.ts"],
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
      {
        // Real-network live gates ONLY. NO setupFiles → no MSW server is registered, so both `fetch`
        // AND the global `WebSocket` reach the real network untouched. This is REQUIRED, not stylistic:
        // MSW 2.x's setupServer patches `globalThis.WebSocket` and intercepts fetch, so a live gate
        // placed in the `integration` project hard-fails under onUnhandledRequest:"error" (a neon-http
        // fetch is rejected; a neon-serverless WS is rejected too). Every file here is skipIf-gated on an
        // EXPLICIT opt-in flag (e.g. AUTH_LIVE_TEST=1) ON TOP of creds, and the default runners exclude
        // this project — `pnpm test`/`test:cov` are scoped to unit+integration; run it via `pnpm test:live`.
        extends: true,
        test: {
          name: "live",
          environment: "node",
          isolate: true,
          include: ["{packages,apps}/*/**/*.live.test.ts"],
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
        // apps/web: the health route (auth.ts + its +server.ts) now has a node-pool suite and IS covered;
        // only the Inngest serve endpoint stays excluded — its lazy `serve()` memoization is a cold-start
        // perf detail (heavy scaffolding, ~0 mutation yield) deliberately left untested (Phase 4 decision).
        "apps/web/src/routes/api/inngest/**",
      ],
      // CAVEAT: v8 coverage does NOT work under workerd. A future @cloudflare/vitest-pool-workers
      // project (a true in-isolate scrapers Worker suite) must use provider:"istanbul" and merge
      // separately. The scrapers Worker is tested today as pure dispatch/cursor logic in the node pool.
    },
  },
});
