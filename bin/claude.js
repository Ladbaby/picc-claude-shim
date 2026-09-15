#!/usr/bin/env node
/**
 * Claude Code CLI drop-in shim.
 *
 * Speaks the Claude Code NDJSON protocol (`--output-format stream-json
 * --input-format stream-json [--permission-prompt-tool stdio]`) over
 * stdin/stdout and bridges to a pi AgentSession internally.
 *
 * Run as `claude` (via the `claude.cmd` / `claude` shim binary in a
 * directory on PATH or via `HAPI_CLAUDE_PATH=...`).
 *
 * Implementation note: this script is plain ESM JavaScript. The TypeScript
 * sources in `../src/` are loaded at runtime via jiti (which is bundled by
 * @earendil-works/pi-coding-agent — the same load mechanism pi uses).
 *
 * FAST PATH: `--version`/`-v`/`-V` (and `--help`/`-h`) are handled BEFORE
 * jiti/entry.ts is loaded. jiti pulls in the full pi runtime, which takes
 * many seconds; T3 Code's version probe waits only 4s, so we must not pay
 * that cost to answer `claude --version`. The heavy loader is a *dynamic*
 * `import()` that runs only on the slow path (top-level static imports would
 * be hoisted and defeat the fast path).
 */

import { CLAUDE_CODE_VERSION, CLAUDE_CODE_VERSION_LINE } from "../src/version.js";

const HELP_TEXT = [
  `Claude Code ${CLAUDE_CODE_VERSION}`,
  "",
  "Usage: claude [options]",
  "",
  "Options:",
  "  -p, --print <prompt>           Print response and exit (non-interactive).",
  "      --output-format <fmt>      Output format: text|json|stream-json.",
  "      --input-format <fmt>       Input format: stream-json.",
  "      --verbose                  Verbose logging.",
  "      --system-prompt <text>     Replace the system prompt.",
  "      --append-system-prompt <t> Append to the system prompt.",
  "      --permission-prompt-tool stdio  Enable tool permission prompts over stdio.",
  "      --resume <session-id>      Resume a previous session.",
  "      --continue                 Continue the most recent session.",
  "      --settings <path>          Settings JSON path (logged, not parsed).",
  "      --allowedTools <a,b>       Comma-separated tool allowlist.",
  "      --disallowedTools <a,b>    Comma-separated tool blocklist.",
  "      --add-dir <path>           Add a directory for tool access (repeatable).",
  "      --permission-mode <mode>   default|acceptEdits|bypassPermissions|plan|auto.",
  "      --model <id>               Model identifier.",
  "      --effort <level>           max|high|medium|low|minimal.",
  "      --fallback-model <id>      Fallback model on primary failure.",
  "      --max-turns <n>            Maximum agentic turns.",
  "  -h, --help                     Show this help.",
  "  -v, --version                  Print version.",
  "",
  "Drop-in replacement for Claude Code's CLI backed by pi.",
  "Local (interactive) mode is not supported; this binary speaks",
  "the stream-json protocol that the Claude Agent SDK uses.",
].join("\n");

const argv = process.argv.slice(2);

// ---- Fast paths (no jiti, no pi runtime) ----
if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "-V")) {
  process.stdout.write(`${CLAUDE_CODE_VERSION_LINE}\n`);
  process.exit(0);
}
if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
  process.stdout.write(`${HELP_TEXT}\n`);
  process.exit(0);
}

// ---- Slow path: load the pi-backed orchestrator ----
const { runClaudeShim } = await import("./entry-slow.mjs");
runClaudeShim(process.argv.slice(2)).then(
  (code) => {
    process.exit(code ?? 0);
  },
  (err) => {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    process.stderr.write(`pi-claude-shim: fatal: ${msg}\n`);
    process.exit(1);
  },
);
