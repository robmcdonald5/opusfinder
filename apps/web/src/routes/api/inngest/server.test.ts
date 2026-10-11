/**
 * Unit suite for the Inngest serve route's PUT (sync) wrapper. The SDK's `serve` and the function deps are
 * module-mocked; what is pinned is which sync requests the wrapper lets through to the SDK.
 */
import { describe, expect, it, vi } from "vitest";

const { sdkPut } = vi.hoisted(() => ({ sdkPut: vi.fn(async () => new Response("synced")) }));

vi.mock("inngest/sveltekit", () => ({
  serve: () => ({ GET: vi.fn(), POST: vi.fn(), PUT: sdkPut }),
}));
vi.mock("@opusfinder/inngest", () => ({ createAllFunctions: () => [], inngest: {} }));
vi.mock("@opusfinder/inngest/backfill-deps", () => ({ buildBackfillDeps: () => ({}) }));
vi.mock("@opusfinder/inngest/deps", () => ({ buildDigestDeps: () => ({}) }));
vi.mock("@opusfinder/inngest/health-deps", () => ({ buildHealthDeps: () => ({}) }));
vi.mock("@sveltejs/kit", () => ({
  json: (body: unknown, init?: { status?: number }) =>
    new Response(JSON.stringify(body), { status: init?.status ?? 200 }),
}));

import { PUT } from "./+server";

function callPUT(query = ""): Promise<Response> {
  const href = `https://opusfinder.ai/api/inngest${query}`;
  return PUT({
    request: new Request(href, { method: "PUT" }),
    url: new URL(href),
  } as never) as Promise<Response>;
}

describe("PUT /api/inngest", () => {
  it("rejects a sync carrying any query param but deployId (it would be registered into every function URL)", async () => {
    const res = await callPUT("?probe=trust");

    expect(res.status).toBe(400);
    expect(sdkPut).not.toHaveBeenCalled();
  });

  it.each(["", "?deployId=dpl_123"])("passes the sync %j through to the SDK", async (query) => {
    sdkPut.mockClear();

    const res = await callPUT(query);

    expect(await res.text()).toBe("synced");
    expect(sdkPut).toHaveBeenCalledOnce();
  });
});
