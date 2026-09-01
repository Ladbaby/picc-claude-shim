/**
 * Smoke test for the translator's input handler.
 *
 * Verifies:
 *  - {type:"user"}    -> onUserMessage(text) is invoked with the right text
 *  - {type:"control_response", request_id, response:{...}} -> resolves the
 *    matching pending permission
 *  - {type:"control_cancel_request", request_id} -> rejects with deny
 */

import {
  handleClaudeInput,
  type PendingPermission,
} from "../src/translator.js";

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

let userTextSeen: string | null = null;
const pending = new Map<string, PendingPermission>();

function makePending(requestId: string): Promise<{ behavior: "allow" | "deny"; [k: string]: unknown }> {
  return new Promise((resolve) => {
    pending.set(requestId, {
      requestId,
      toolName: "Bash",
      toolCallId: "toolu_1",
      input: {},
      resolve: (r) => {
        pending.delete(requestId);
        resolve(r);
      },
    });
  });
}

// 1. user text
handleClaudeInput(
  JSON.stringify({
    type: "user",
    message: { role: "user", content: "hello" },
  }),
  {
    pendingPermissions: pending,
    onUserMessage: (t) => {
      userTextSeen = t;
    },
  },
);
assertEq(userTextSeen, "hello", "user text content");

// 2. user with array content (text block)
userTextSeen = null;
handleClaudeInput(
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: "world" }, { type: "text", text: "!!" }],
    },
  }),
  {
    pendingPermissions: pending,
    onUserMessage: (t) => {
      userTextSeen = t;
    },
  },
);
assertEq(userTextSeen, "world\n!!", "user array content joined");

// 3. control_response allow
{
  const reqId = "perm_aaa";
  const promise = makePending(reqId);
  handleClaudeInput(
    JSON.stringify({
      type: "control_response",
      response: {
        request_id: reqId,
        subtype: "success",
        response: { behavior: "allow", updatedInput: { foo: 1 } },
      },
    }),
    { pendingPermissions: pending, onUserMessage: () => {} },
  );
  const r = await promise;
  assertEq(r.behavior, "allow", "control_response allow behavior");
  // updatedInput carried through
  assertEq(
    JSON.stringify(r),
    JSON.stringify({ behavior: "allow", updatedInput: { foo: 1 } }),
    "control_response payload",
  );
}

// 4. control_response error subtype -> deny
{
  const reqId = "perm_bbb";
  const promise = makePending(reqId);
  handleClaudeInput(
    JSON.stringify({
      type: "control_response",
      response: {
        request_id: reqId,
        subtype: "error",
        error: "user rejected",
      },
    }),
    { pendingPermissions: pending, onUserMessage: () => {} },
  );
  const r = await promise;
  assertEq(r.behavior, "deny", "error subtype -> deny");
  assertEq(
    JSON.stringify(r),
    JSON.stringify({ behavior: "deny", message: "user rejected" }),
    "error message relayed",
  );
}

// 5. control_cancel_request -> deny with cancelled message
{
  const reqId = "perm_ccc";
  const promise = makePending(reqId);
  handleClaudeInput(
    JSON.stringify({ type: "control_cancel_request", request_id: reqId }),
    { pendingPermissions: pending, onUserMessage: () => {} },
  );
  const r = await promise;
  assertEq(r.behavior, "deny", "cancel -> deny");
  assertEq((r as { message?: string }).message, "cancelled by client", "cancel message");
}

// 6. malformed JSON returns null and does not throw.
{
  let thrown = false;
  try {
    handleClaudeInput("not json", { pendingPermissions: pending, onUserMessage: () => {} });
  } catch {
    thrown = true;
  }
  assertEq(thrown, false, "malformed JSON does not throw");
}

// 7. JSON without 'type' is ignored gracefully.
{
  let thrown = false;
  try {
    handleClaudeInput('{"foo":1}', { pendingPermissions: pending, onUserMessage: () => {} });
  } catch {
    thrown = true;
  }
  assertEq(thrown, false, "unknown message shape does not throw");
}
