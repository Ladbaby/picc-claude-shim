/**
 * Smoke test for the structured-output extractor (Phase 2g).
 *
 * Run via: node test/structured-output.test.ts
 */

import { extractStructuredOutput } from "../src/structured-output.js";

function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    process.stderr.write(
      `FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`ok ${label}\n`);
}

// 1. Model returns a clean JSON object matching the schema.
{
  const schema = '{"type":"object","properties":{"subject":{"type":"string"},"body":{"type":"string"}},"required":["subject","body"]}';
  const out = extractStructuredOutput('{"subject":"Add parser","body":"Details"}', schema);
  assertEq(JSON.stringify(out), '{"subject":"Add parser","body":"Details"}', "clean json object");
}

// 2. JSON embedded in prose / markdown fence.
{
  const schema = '{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}';
  const out = extractStructuredOutput(
    'Here is the title:\n```json\n{"title":"My PR"}\n```',
    schema,
  );
  assertEq(JSON.stringify(out), '{"title":"My PR"}', "json in fence");
}

// 3. Missing required key is filled with "".
{
  const schema = '{"type":"object","properties":{"subject":{"type":"string"},"body":{"type":"string"}},"required":["subject","body"]}';
  const out = extractStructuredOutput('{"subject":"Only subject"}', schema);
  assertEq(JSON.stringify(out), '{"subject":"Only subject","body":""}', "fills missing required body");
}

// 4. Model returns only prose (no JSON) — fall back to required keys.
{
  const schema = '{"type":"object","properties":{"subject":{"type":"string"},"body":{"type":"string"}},"required":["subject","body"]}';
  const out = extractStructuredOutput("This is the commit subject line.", schema);
  assertEq(
    JSON.stringify(out),
    '{"subject":"This is the commit subject line.","body":""}',
    "prose falls back to required keys",
  );
}

// 5. Array schema — prose wrapped in a one-element array.
{
  const schema = '{"type":"array","items":{"type":"string"}}';
  const out = extractStructuredOutput("hello world", schema);
  assertEq(JSON.stringify(out), '["hello world"]', "array schema wraps text");
}

// 6. No schema — raw text returned as-is.
{
  const out = extractStructuredOutput("plain text", undefined);
  assertEq(out, "plain text", "no schema -> raw text");
}

// 7. Malformed schema string is tolerated (treated as no schema).
{
  const out = extractStructuredOutput('{"a":1}', "{not valid json");
  assertEq(JSON.stringify(out), '{"a":1}', "malformed schema tolerated");
}
