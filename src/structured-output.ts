/**
 * Structured-output helpers for the `--output-format json --json-schema
 * <schema>` path (t3code's commit/PR/title generation,
 * `textGeneration/ClaudeTextGeneration.ts`).
 *
 * That driver spawns `claude -p --output-format json --json-schema <schema>`,
 * sends the prompt on stdin, and parses stdout as exactly one of:
 *   A. `{"structured_output": <value>}`
 *   B. an array whose last `type === "result"` entry carries `structured_output`.
 * It then decodes `structured_output` against the supplied JSON Schema and
 * errors on mismatch.
 *
 * {@link extractStructuredOutput} turns the assistant's raw text into a value
 * that decodes against the requested schema: it parses a JSON object from the
 * text (direct, or embedded in prose / ``` fences) and, as a last resort,
 * builds a minimal object from the schema's required keys so the decode does
 * not blow up when the model returns prose.
 */

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    // not JSON — fall through
  }
  return undefined;
}

/**
 * Fill any missing `required` keys on a parsed object so the value decodes
 * against the schema. Existing values are preserved; missing ones get a
 * type-appropriate default (string → "", object → {}, array → []).
 */
function fillRequired(
  obj: Record<string, unknown>,
  schema: JsonSchema | undefined,
): Record<string, unknown> {
  if (!schema || !Array.isArray(schema.required)) return obj;
  const out: Record<string, unknown> = { ...obj };
  for (const key of schema.required) {
    if (out[key] === undefined) {
      const prop = schema.properties?.[key];
      if (prop?.type === "object") out[key] = {};
      else if (prop?.type === "array") out[key] = [];
      else out[key] = "";
    }
  }
  return out;
}

/**
 * Turn raw model output into a value that decodes against `jsonSchema`.
 *
 * Priority:
 *  1. The text is already a JSON object → use it (filling required keys).
 *  2. A JSON object is embedded in the text (e.g. surrounded by prose or
 *     ```json fences) → use that.
 *  3. No object, but the schema lists required keys → build a minimal object
 *     from them (the first key takes the raw text; the rest get "").
 *  4. The schema is an array type → wrap the text in a one-element array.
 *  5. Otherwise → return the raw text as-is.
 */
export function extractStructuredOutput(
  rawText: string,
  jsonSchema: string | undefined,
): unknown {
  const text = (rawText ?? "").trim();

  let obj = tryParseObject(text);
  if (!obj) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      obj = tryParseObject(text.slice(start, end + 1));
    }
  }

  let schema: JsonSchema | undefined;
  if (jsonSchema) {
    try {
      schema = JSON.parse(jsonSchema) as JsonSchema;
    } catch {
      schema = undefined;
    }
  }

  if (obj && typeof obj === "object") {
    return fillRequired(obj, schema);
  }

  if (schema && Array.isArray(schema.required) && schema.required.length > 0) {
    const out: Record<string, unknown> = {};
    for (const key of schema.required) {
      out[key] = key === schema.required[0] ? text : "";
    }
    return out;
  }

  if (schema && schema.type === "array") {
    return [text];
  }

  return text;
}
