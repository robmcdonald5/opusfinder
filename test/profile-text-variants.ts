import type * as Shared from "@opusfinder/shared";

/** The line each variant text adds, so a test can tell which of the two texts a reader took. */
export const EMBED_ONLY_LINE = "Only in the embedded text";
export const JUDGE_ONLY_LINE = "Only in the judge's text";

/**
 * `@opusfinder/shared` with the profile's two texts made to differ: each appends its own line. Pass
 * it to `vi.mock("@opusfinder/shared", …)` in a test that shows a reader takes its own text and is
 * untouched by a change to the other.
 */
export function withDivergedProfileTexts(actual: typeof Shared): typeof Shared {
  return {
    ...actual,
    profileEmbedText: (profile) => `${actual.profileEmbedText(profile)}\n\n${EMBED_ONLY_LINE}`,
    profileJudgeContext: (profile) =>
      `${actual.profileJudgeContext(profile)}\n\n${JUDGE_ONLY_LINE}`,
  };
}
