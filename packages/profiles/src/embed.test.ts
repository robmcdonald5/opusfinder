import { describe, expect, it, vi } from "vitest";

import { embedQuery } from "./embed";
import type { ProfileEmbedFn } from "./types";

// What this file proves: embedQuery's unwrap-and-validate contract over the injected ProfileEmbedFn
// seam — one wrapped call with inputType 'query', reference pass-through of vector + usage, the ONE
// validation branch (missing / zero-length vector), and rejection transparency. It also PINS the
// deliberate NEGATIVE SPACE: no dimension / finiteness / vector-count / empty-text checks live here.
// Width enforcement is db vectorLiteral at write time (packages/db/src/repos/sql.ts); response-shape
// validation is the embeddings package's parseEmbeddingResponse; the empty-input guard belongs to
// the CALLERS (ingestCv / restructureProfile) because Voyage 400s on empty input. A mutation that
// grows validation inside embedQuery must turn one of the negative-space tests red. Net-new
// coverage — no smoke script retires with this file (test-ingest's embedTokens===42 check is
// preserved as the usage-propagation test below).

const NO_VECTOR_MESSAGE = "embed() returned no usable vector for the profile text";

/** A seam stub resolving a fixed response; call args are asserted via the mock. */
function seamReturning(response: Awaited<ReturnType<ProfileEmbedFn>>) {
  return vi.fn<ProfileEmbedFn>(async () => response);
}

/** Resolve to the rejection reason (failing the test if the promise resolved) so messages can be
 *  pinned EXACTLY — `.rejects.toThrow(string)` is substring matching and would stay green if the
 *  message grew a wrapper prefix. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("embedQuery — unwrap-and-validate over the injected embed seam (unit: pure, stubbed ProfileEmbedFn)", () => {
  it("calls the seam exactly once with a single-element [text] array and inputType query", async () => {
    const embed = seamReturning({ embeddings: [[0.5, 0.5]], usage: { totalTokens: 7 } });
    await embedQuery(embed, "backend engineer profile");
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith(["backend engineer profile"], { inputType: "query" });
  });

  it("returns the first vector by reference and the seam usage verbatim (totalTokens 42)", async () => {
    const vector = [0.25, 0.5, 0.75];
    const usage = { totalTokens: 42 };
    const embed = seamReturning({ embeddings: [vector], usage });
    const result = await embedQuery(embed, "profile text");
    // Same REFERENCES, not copies — a defensive [...vector] / {...usage} would break these pins.
    expect(result.vector).toBe(vector);
    expect(result.usage).toBe(usage);
    // The retired-smoke-adjacent check (test-ingest happy path): tokens surface from the seam.
    expect(result.usage.totalTokens).toBe(42);
  });

  it("treats usage.totalTokens 0 as a normal result, not an error", async () => {
    const embed = seamReturning({ embeddings: [[1]], usage: { totalTokens: 0 } });
    const result = await embedQuery(embed, "tiny");
    expect(result.usage).toEqual({ totalTokens: 0 });
    expect(result.vector).toEqual([1]);
  });

  it("rejects with the exact no-usable-vector message when embeddings is []", async () => {
    const embed = seamReturning({ embeddings: [], usage: { totalTokens: 3 } });
    const err = await rejectionOf(embedQuery(embed, "profile text"));
    expect(err.message).toBe(NO_VECTOR_MESSAGE);
  });

  it("rejects with the same exact message when the first vector is zero-length", async () => {
    const embed = seamReturning({ embeddings: [[]], usage: { totalTokens: 3 } });
    const err = await rejectionOf(embedQuery(embed, "profile text"));
    expect(err.message).toBe(NO_VECTOR_MESSAGE);
  });

  it("propagates a seam rejection unchanged — same Error instance, no wrapping", async () => {
    const boom = new Error("voyage: 429 rate limited");
    const embed = vi.fn<ProfileEmbedFn>(async () => {
      throw boom;
    });
    const err = await rejectionOf(embedQuery(embed, "profile text"));
    // Identity, not message equality — a catch-and-rethrow wrapper could preserve the text.
    expect(err).toBe(boom);
  });

  it("negative space: passes a wrong-width vector through unvalidated — dimension enforcement lives in db vectorLiteral, not here", async () => {
    const wrongWidth = [1, 2, 3]; // deliberately unrelated to EMBEDDING_DIMENSIONS
    const embed = seamReturning({ embeddings: [wrongWidth], usage: { totalTokens: 5 } });
    const result = await embedQuery(embed, "profile text");
    // Resolved (no width throw) AND untransformed — pins that embedQuery adds no dimension check.
    expect(result.vector).toBe(wrongWidth);
  });

  it("negative space: ignores extra vectors beyond index 0 and passes non-finite elements (NaN) through — no finiteness check", async () => {
    const first = [Number.NaN, Number.POSITIVE_INFINITY, 0.5];
    const embed = seamReturning({ embeddings: [first, [9, 9, 9]], usage: { totalTokens: 5 } });
    const result = await embedQuery(embed, "profile text");
    expect(result.vector).toBe(first); // embeddings[1] is silently ignored
    expect(Number.isNaN(result.vector[0])).toBe(true); // NaN survives — no Number.isFinite guard
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("negative space: forwards an empty text string to the seam unchecked — the empty-input guard is the callers' responsibility", async () => {
    const embed = seamReturning({ embeddings: [[0.1]], usage: { totalTokens: 0 } });
    const result = await embedQuery(embed, "");
    expect(embed).toHaveBeenCalledWith([""], { inputType: "query" });
    expect(result.vector).toEqual([0.1]);
  });
});
