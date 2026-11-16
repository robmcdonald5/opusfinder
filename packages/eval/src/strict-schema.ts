/**
 * A zod schema as the JSON schema a strict structured-output mode will take. Hosts differ in which JSON
 * Schema keywords their constrained decoding accepts, and some reject a request over one they don't, so
 * only the keywords they all take go out as constraints: types, object shapes (closed, as strict modes
 * require), arrays, enums, constants and unions. Everything else zod emits (number bounds, string lengths
 * and patterns, array sizes) is written into the field's description, where the model still reads it. The
 * caller validates the reply with the zod schema itself, so those are checked there, not by the host.
 */
import { z } from "zod";

type JsonSchema = Record<string, unknown>;

const KEPT: ReadonlySet<string> = new Set([
  "type",
  "description",
  "required",
  "enum",
  "const",
  "$ref",
]);
const NESTED_MAPS: ReadonlySet<string> = new Set(["properties", "$defs"]);
const NESTED_LISTS: ReadonlySet<string> = new Set(["anyOf", "allOf"]);

/** Convert `schema` for a `json_schema` response format sent with `strict: true`. An optional field stays
 *  optional (absent from `required`); a host whose strict mode wants every field required needs it
 *  written as nullable instead. */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _dialect, ...root } = z.toJSONSchema(schema) as JsonSchema;
  return strict(root);
}

function strict(node: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  const described: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (KEPT.has(key)) {
      out[key] = value;
    } else if (NESTED_MAPS.has(key)) {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, JsonSchema>).map(([name, child]) => [
          name,
          strict(child),
        ]),
      );
    } else if (NESTED_LISTS.has(key) || key === "oneOf") {
      out[key === "oneOf" ? "anyOf" : key] = (value as JsonSchema[]).map(strict);
    } else if (key === "items" && !Array.isArray(value)) {
      out.items = strict(value as JsonSchema);
    } else if (key !== "additionalProperties") {
      described.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  if (node.type === "object") out.additionalProperties = false;
  if (described.length > 0) {
    const own = typeof out.description === "string" ? `${out.description}\n\n` : "";
    out.description = `${own}{${described.join(", ")}}`;
  }
  return out;
}
