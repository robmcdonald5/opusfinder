import { expect } from "vitest";

/**
 * Shared rejection-capture helpers: resolve to a promise's rejection reason so tests can assert
 * on it directly — `.rejects.toThrow(string)` is substring matching and would stay green if a
 * message grew a wrapper prefix, so message-pinning tests capture the error and match EXACTLY.
 * Both helpers fail the test loudly if the promise unexpectedly resolves.
 */

/** Resolve to the rejection reason, asserted to be an Error — for exact `.message` (and
 *  `.cause`) pinning. */
export async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/** Resolve to the rejection reason VERBATIM (no Error assert/cast) — for identity assertions
 *  (`toBe(sentinel)`) proving an error propagates unwrapped, where the reason may not even be an
 *  Error (a test rejects with a bare string). */
export async function rejectionReasonOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}
