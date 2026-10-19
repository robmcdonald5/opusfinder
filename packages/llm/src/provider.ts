/**
 * The model tiers the rest of the system selects between, so callers never hardcode
 * raw model IDs. Haiku = cheap/fast (rerank, CV extraction); Sonnet = stronger (digest
 * synthesis, eval labels).
 */
export type ModelAlias = "haiku" | "sonnet";

/**
 * How much the model works before answering (`output_config.effort`). Both tiers think adaptively by
 * default and reject sampling parameters, so effort is the quality/cost dial. Set it per call: the
 * tier defaults differ (Haiku 5.5 `medium`, Sonnet 5.5 `high`), and thinking counts toward the
 * output-token cap, so a short cap needs a low effort.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * `"adaptive"` (the default) lets the model decide how much to think, scaled by {@link Effort};
 * `"off"` asks for no extended thinking. Off works only at effort `high` or below, and Sonnet's
 * spelling of it is rejected by the Batch API.
 */
export type Thinking = "adaptive" | "off";

// OpenRouter model slugs, never the dated builds behind them: each slug names one version line and
// resolves to that line's newest build, so a family upgrade stays a deliberate edit here.
const MODEL_IDS: Record<ModelAlias, string> = {
  haiku: "anthropic/claude-haiku-5.5",
  sonnet: "anthropic/claude-sonnet-5.5",
};

/** The OpenRouter model slug for a tier alias. */
export function modelId(alias: ModelAlias): string {
  return MODEL_IDS[alias];
}
