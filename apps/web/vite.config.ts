import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  ssr: {
    // The @opusfinder/* workspace packages publish RAW TypeScript source (`exports` → `./src/*.ts`), so
    // Vite must BUNDLE (not externalize) them for the serverless Node build — otherwise Node tries to
    // `import` a `.ts` file at runtime and fails. Their own deps (drizzle, @anthropic-ai/sdk, resend,
    // @neondatabase/serverless, inngest) stay external and are traced into the function by adapter-vercel.
    noExternal: [/^@opusfinder\//],
  },
});
