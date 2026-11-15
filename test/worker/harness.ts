import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { Miniflare } from "miniflare";

/**
 * Runs test/worker/shared-packages.ts in workerd (Miniflare): bundled exactly as `pnpm guard:worker`
 * bundles it, with the scrapers Worker's compatibility date and no compatibility flags (so no
 * `nodejs_compat`: a Node global or builtin fails here as it would in production). Every outbound fetch
 * goes to the test's `outbound` handler; nothing reaches the network.
 */
const ENTRY = fileURLToPath(new URL("./shared-packages.ts", import.meta.url));
const SCRAPERS_WRANGLER = fileURLToPath(
  new URL("../../apps/scrapers/wrangler.toml", import.meta.url),
);

export type Outbound = (request: Request) => Response | Promise<Response>;

export interface SharedPackagesWorker {
  /** Run one of the entry's probes; its result, or the message of what it threw. */
  probe: (name: string) => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
  dispose: () => Promise<void>;
}

function compatibilityDate(): string {
  const m = /^compatibility_date\s*=\s*"([^"]+)"/m.exec(readFileSync(SCRAPERS_WRANGLER, "utf8"));
  if (!m?.[1]) throw new Error("compatibility_date not found in apps/scrapers/wrangler.toml");
  return m[1];
}

export async function startSharedPackagesWorker(
  bindings: Record<string, string>,
  outbound: Outbound,
): Promise<SharedPackagesWorker> {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    logLevel: "silent",
  });
  const code = result.outputFiles[0]?.text;
  if (!code) throw new Error("esbuild produced no output");
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "index.js", contents: code }],
    compatibilityDate: compatibilityDate(),
    bindings,
    outboundService: (request: Request) => outbound(request),
  });
  await mf.ready;
  return {
    probe: async (name) => {
      const res = await mf.dispatchFetch(`https://worker.test/${name}`);
      return (await res.json()) as Awaited<ReturnType<SharedPackagesWorker["probe"]>>;
    },
    dispose: () => mf.dispose(),
  };
}
