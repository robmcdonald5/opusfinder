import { z } from "zod";

/**
 * The normalizer's answer for one location string. `reason` comes first: with thinking off, writing the
 * one-line reading before the places is the model's only chance to reason before it commits to them.
 * Country codes are plain strings here (structured outputs ignore length/pattern constraints); the
 * GeoNames check rejects any code that isn't a real country. Areas are plain strings too, not an enum, so
 * a bloc outside the list reaches `locations:report` by its own name instead of being forced onto the
 * nearest listed one; the check expands the listed ones and keeps the rest as unmatched.
 */
export const LocationAnswerSchema = z.object({
  reason: z.string().describe("One short sentence: how the text was read."),
  places: z
    .array(
      z.object({
        city: z
          .string()
          .nullable()
          .describe("The city, as GeoNames names it in English; null for a region or country."),
        region: z
          .string()
          .nullable()
          .describe(
            "The first-level region (state, province) in full English; null when the text names only a country.",
          ),
        country: z.string().describe("ISO 3166-1 alpha-2 country code, e.g. US, GB, DE."),
        kind: z.enum(["city", "region", "country"]),
      }),
    )
    .describe(
      "Every city the text names; a region or country only where the text names no city in it.",
    ),
  remoteCountries: z
    .array(z.string())
    .describe(
      "ISO 3166-1 alpha-2 codes of the countries a remote role is open to; empty when unrestricted or not remote.",
    ),
  areas: z
    .array(z.string())
    .describe(
      "World regions or blocs the job is limited to, by their names in the list (Europe, EMEA, North America, …); empty when none.",
    ),
  confidence: z.enum(["high", "medium", "low"]),
});

export type LocationAnswerValue = z.infer<typeof LocationAnswerSchema>;
export type AnsweredPlace = LocationAnswerValue["places"][number];
