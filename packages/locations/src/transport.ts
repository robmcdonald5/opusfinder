/**
 * The production {@link LocationModel}: the location normalizer's requests over the @opusfinder/llm
 * transport. Every caller (the digest deps, the locations CLIs, eval:locations) builds the model here, so
 * the transport is wired in one place.
 */
import type { LocationModel } from "./model";

export function createLocationModel(): LocationModel {
  const unwired = (): never => {
    throw new Error(
      "The location model has no transport yet: it is wired to @opusfinder/llm's provider switch, which this " +
        "branch has not picked up.",
    );
  };
  return { generate: unwired, batch: unwired };
}
