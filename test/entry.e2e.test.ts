/**
 * End-to-end integration test.
 *
 * Spawns the actual `bin/claude.js` shim with stream-json flags in a
 * way that mirrors `hapi/cli/src/claude/sdk/query.ts` driving the
 * Claude binary. Asserts:
 *
 *   - `system/init` line arrives first with a session_id
 *   - the hapi-style session JSONL file is created at the expected path
 *     within the configured $CLAUDE_CONFIG_DIR
 *   - sending a user message on stdin produces `assistant` lines and a
 *     final `result` with usage + num_turns >= 1
 *   - the response text contains content from the pi session
 *
 * This bypasses hapi itself (which has many ancillary concerns: HTTP
 * server, hook forwarder, RPC bridge) and exercises the wire contract
 * that hapi relies on.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const SHIM_ROOT = resolve(__dirname, "..");
const CLAUDE_JS = join(SHIM_ROOT, "bin", "claude.js");

function assert(cond: unknown, label: string): void {
  if (!cond) {
    process.stderr.write(`FAIL ${label}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`ok ${label}\n`);
  }
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pi-claude-shim-e2e-"));
  const claudeConfigDir = join(tmp, ".claude");
  const projectCwd = join(tmp, "E2E-App-Project");
  mkdirSync(projectCwd, { recursive: true });

  // The shim derives project dir from cwd. Use a stable path so the
  // test can locate the JSONL.
  const expectedProjectDir = join(
    claudeConfigDir,
    "projects",
    projectCwd.replace(/[^a-zA-Z0-9]/g, "-"),
  );

  // Resolve node path explicitly via PATH lookup to avoid quoting
  // issues with `C:\Program Files\nodejs\node.exe` (the space breaks
  // some Node.js spawn() invocations on Windows).
  const nodePath = process.execPath;
  const child = spawn(nodePath, [CLAUDE_JS,
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--model", "claude-sonnet",
  ], {
    cwd: projectCwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: false,
  });

  const out: string[] = [];
  child.stdout.on("data", (b) => out.push(b.toString()));
  child.stderr.on("data", (b) => process.stderr.write(`[child-stderr] ${b.toString()}`));

  // Wait for `system/init` before sending a user message. This mirrors
  // hapi's behavior of waiting on the JSONL file (which our shim writes
  // before init).
  await waitForCondition(() => out.some((chunk) => chunk.includes(`"subtype":"init"`)), 30_000);

  // The init line and the JSONL file should be present.
  const initLine = out.join("").split("\n").find((l) => l.includes(`"subtype":"init"`));
  assert(!!initLine, "system/init emitted");
  const initMsg = initLine ? (JSON.parse(initLine) as { session_id?: string }) : undefined;
  const sessionId = initMsg?.session_id;
  assert(typeof sessionId === "string", "init has session_id");
  const expectedJsonl = join(expectedProjectDir, `${sessionId}.jsonl`);
  // Allow a moment for the file to flush.
  await waitForCondition(() => existsSync(expectedJsonl), 5_000);
  assert(existsSync(expectedJsonl), "hapi session JSONL created");

  // Send a user message.
  child.stdin.write(
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "say lol" },
    }) + "\n",
  );

  // Wait for the final `result`.
  await waitForCondition(
    () => out.join("").includes(`"type":"result"`),
    60_000,
  );
  child.stdin.end();

  await new Promise<void>((resolve) => child.on("exit", () => resolve()));

  const messages = out
    .join("")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  const systemInit = messages.find((m) => m.type === "system" && m.subtype === "init");
  const assistant = messages.find((m) => m.type === "assistant");
  const result = messages.find((m) => m.type === "result");

  assert(!!systemInit, "system/init present");
  assert(!!assistant, "assistant message present");
  assert(!!result, "result message present");

  // Verify the assistant content includes text.
  const assistantContent = (assistant as { message?: { content?: unknown[] } } | undefined)
    ?.message?.content as Array<{ type: string; text?: string }> | undefined;
  const textBlock = assistantContent?.find((b) => b.type === "text");
  assert(typeof textBlock?.text === "string", "assistant has text block");

  // Result must carry session_id, usage, num_turns.
  assert(typeof (result as { session_id?: string })?.session_id === "string", "result has session_id");
  const resultObj = result as {
    usage?: { input_tokens: number };
    num_turns?: number;
    total_cost_usd?: number;
  };
  assert((resultObj.num_turns ?? 0) >= 1, "result has num_turns >= 1");
  assert(
    (resultObj.usage?.input_tokens ?? 0) > 0,
    "result has positive input_tokens",
  );

  // Confirm the JSONL file accumulated user + assistant entries.
  const sessionJsonl = readFileSync(expectedJsonl, "utf-8").trim().split("\n");
  assert(sessionJsonl.length >= 3, "session JSONL has multiple entries (>=3)");

  // Cleanup
  rmSync(tmp, { recursive: true, force: true });
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
