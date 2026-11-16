/**
 * A zod schema as the JSON schema sent with `strict: true`. Hosts enforce a schema differently, measured
 * on 2026-11-15 through OpenRouter:
 * - DeepInfra enforces every keyword in decoding (number bounds, string lengths, patterns, array sizes),
 *   but the model is shown none of the schema's text, so a field description changes nothing there.
 * - Anthropic enforces shapes, enums and patterns and reads the descriptions, but number bounds, string
 *   lengths and array sizes are dropped on the way, without an error.
 * So each bound goes out twice: as its keyword, for the hosts that decode against it, and written into
 * the field's description, for the hosts that only read it. Objects are closed, as strict modes require.
 * The caller validates the reply with the zod schema itself, whatever the host did with either.
 */
import { z } from "zod";

type JsonSchema = Record<string, unknown>;

/** The keywords that shape the value; every host takes these as constraints. The rest are bounds. */
const SHAPE: ReadonlySet<string> = new Set([
  "type",
  "description",
  "required",
  "enum",
  "const",
  "$ref",
]);
const NESTED_MAPS: ReadonlySet<string> = new Set(["properties", "$defs"]);
const NESTED_LISTS: ReadonlySet<string> = new Set(["anyOf", "allOf"]);

/** Convert `schema` for a `json_schema` response format. An optional field stays optional (absent from
 *  `required`); a host whose strict mode wants every field required needs it written as nullable. */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _dialect, ...root } = z.toJSONSchema(schema) as JsonSchema;
  return strict(root);
}

function strict(node: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  const bounds: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (SHAPE.has(key)) {
      out[key] = value;
    } else if (NESTED_MAPS.has(key)) {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, JsonSchema>).map(([name, child]) => [
          name,
          strict(child),
        ]),
      );
    } else if (NESTED_LISTS.has(key) || key === "oneOf") {
      // Strict modes take `anyOf` only; zod writes a discriminated union as `oneOf`.
      out[key === "oneOf" ? "anyOf" : key] = (value as JsonSchema[]).map(strict);
    } else if (key === "items" && !Array.isArray(value)) {
      out.items = strict(value as JsonSchema);
    } else if (key !== "additionalProperties") {
      out[key] = value;
      bounds.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  if (node.type === "object") out.additionalProperties = false;
  if (bounds.length > 0) {
    const own = typeof out.description === "string" ? `${out.description}\n\n` : "";
    out.description = `${own}{${bounds.join(", ")}}`;
  }
  return out;
}
