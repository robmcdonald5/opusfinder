import adapter from "@sveltejs/adapter-vercel";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Serverless Node, NOT edge — the digest/backfill deps reach @anthropic-ai/sdk +
    // @neondatabase/serverless, which need Node. Serverless Node is adapter-vercel's default (edge is
    // opt-in via `runtime: 'edge'`), so we don't set `runtime` — it's deprecated in adapter-vercel v6;
    // the function's Node version follows the Vercel project setting (set it to 22.x in the dashboard).
    // maxDuration 300 = the Hobby ceiling: one Inngest step (an F8 backfill page / a synthesis poll) must
    // fit inside it; the digest's long batch wait is step.sleep (suspends with zero open compute).
    adapter: adapter({ maxDuration: 300 }),
  },
};

export default config;
