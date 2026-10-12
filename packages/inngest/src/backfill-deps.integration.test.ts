import { NonRetriableError } from "inngest";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@test/msw/server";
import { rejectionOf } from "@test/rejection";

import { buildBackfillDeps } from "./backfill-deps";

// The production drain embedder over MSW: a Voyage rejection must end the run (a retry re-pays the page
// and fails the same way), while a transient failure stays retryable. No query runs, so the db is unused.

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

describe("buildBackfillDeps().embed", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost/db");
    vi.stubEnv("VOYAGE_API_KEY", "pa-test");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("throws NonRetriableError on a Voyage rejection", async () => {
    server.use(http.post(VOYAGE_URL, () => HttpResponse.text("bad input", { status: 400 })));

    const err = await rejectionOf(buildBackfillDeps().embed(["x"], { inputType: "document" }));

    expect(err).toBeInstanceOf(NonRetriableError);
    expect(err.message).toMatch(/Voyage embeddings request failed: 400/);
  });

  it("leaves a transient Voyage failure retryable", async () => {
    server.use(http.post(VOYAGE_URL, () => HttpResponse.text("unavailable", { status: 503 })));

    const err = await rejectionOf(buildBackfillDeps().embed(["x"], { inputType: "document" }));

    expect(err).not.toBeInstanceOf(NonRetriableError);
    expect(err.message).toMatch(/Voyage embeddings request failed: 503/);
  });
});
