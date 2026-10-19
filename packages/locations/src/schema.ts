import { z } from "zod";

/**
 * The normalizer's answer for one location string. `reason` comes first: with thinking off, writing the
 * one-line reading before the places is the model's only chance to reason before it commits to them.
 * Country codes are plain strings here (structured outputs ignore length/pattern constraints); the
 * GeoNames check rejects any code that isn't a real country.
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
  confidence: z.enum(["high", "medium", "low"]),
});

export type LocationAnswerValue = z.infer<typeof LocationAnswerSchema>;
export type AnsweredPlace = LocationAnswerValue["places"][number];

/** The JSON Schema sent as the structured-output format. */
export const LOCATION_ANSWER_JSON_SCHEMA = z.toJSONSchema(LocationAnswerSchema) as Record<
  string,
  unknown
>;
