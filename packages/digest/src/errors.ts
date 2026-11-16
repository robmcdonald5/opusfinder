/**
 * An error a retry can't fix: a broken invariant, a malformed input, a batch that failed as a whole. The
 * stage code throws it; the engine running the steps (apps/digest's Workflows) turns it into its own
 * no-retry error, so the step isn't retried and the run fails at once.
 */
export class NonRetriableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetriableError";
  }
}
