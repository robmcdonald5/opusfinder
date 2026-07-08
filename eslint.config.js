// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.svelte-kit/**",
      "**/.wrangler/**",
      "packages/db/drizzle/**",
      "research/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module" },
    rules: {
      // The MSW server (test/setup/msw.ts) is a Vitest setupFile for the `integration` project ONLY.
      // Importing it anywhere runs its top-level listen/close hooks in that module's context, re-arming
      // MSW (onUnhandledRequest:"error" + a globalThis.WebSocket patch) in the wrong project — which
      // would silently break the no-MSW `live` project. Wire it via vitest.config setupFiles, never import.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@test/setup/msw", "**/test/setup/msw"],
              message:
                "Do not import the MSW server module; it is a Vitest setupFile (integration project only). Importing it re-arms MSW in the wrong project. Wire it via vitest.config setupFiles.",
            },
          ],
        },
      ],
    },
  },
);
