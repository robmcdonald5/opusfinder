/**
 * A Worker that imports the four shared packages the way a real one will: the bare entries, with every
 * key passed in from its bindings. Nothing deploys it. `pnpm guard:worker` bundles it for the edge
 * runtime (no node:* builtin, no env loader in the graph), and
 * packages/locations/src/worker-runtime.integration.test.ts runs that bundle in workerd, one probe per
 * package, against a stubbed network.
 */
import { sendHealthAlert } from "../../packages/email/src/index";
import { embed } from "../../packages/embeddings/src/index";
import { generate, pdfPart } from "../../packages/llm/src/index";
import {
  buildLocationRequest,
  createLocationModel,
  requestId,
} from "../../packages/locations/src/index";

interface Env {
  OPENROUTER_API_KEY: string;
  VOYAGE_API_KEY: string;
  RESEND_API_KEY: string;
  EMAIL_FROM: string;
  ALERT_TO: string;
}

const PROBES: Record<string, (env: Env) => Promise<unknown>> = {
  /** A cached-system call with a PDF part: the Web Crypto session id and the Buffer-free base64. */
  llm: async (env) => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256);
    const { text } = await generate({
      model: "haiku",
      system: "rubric",
      cacheSystem: true,
      messages: [{ role: "user", content: [pdfPart(bytes), { type: "text", text: "go" }] }],
      apiKey: env.OPENROUTER_API_KEY,
    });
    return text;
  },
  /** No key passed and no environment to fall back on. */
  "llm-no-key": async () => {
    await generate({ model: "haiku", messages: [{ role: "user", content: "hi" }] });
  },
  embeddings: async (env) => {
    const { embeddings, usage } = await embed(["a", "b"], {
      inputType: "document",
      apiKey: env.VOYAGE_API_KEY,
    });
    return { vectors: embeddings.length, width: embeddings[0]?.length, usage };
  },
  locations: async (env) => {
    const pair = { companyId: 7, raw: "Columbus, OH" };
    const id = await requestId(pair);
    const model = createLocationModel({ apiKey: env.OPENROUTER_API_KEY });
    return { id, answer: await model.generate(buildLocationRequest(id, { raw: pair.raw })) };
  },
  email: (env) =>
    sendHealthAlert("Health: DEGRADED", "3 checks failing", {
      apiKey: env.RESEND_API_KEY,
      from: env.EMAIL_FROM,
      alertTo: env.ALERT_TO,
    }),
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const probe = PROBES[new URL(request.url).pathname.slice(1)];
    if (!probe) return new Response("unknown probe", { status: 404 });
    try {
      return Response.json({ ok: true, value: (await probe(env)) ?? null });
    } catch (err) {
      return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
};
