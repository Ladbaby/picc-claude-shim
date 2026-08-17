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
 * sources in `../src/` are loaded at runtime via jiti, which is bundled
 * by @earendil-works/pi-coding-agent (the same load mechanism pi uses).
 */

import process from "node:process";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const entryMod = jiti("../src/entry.ts");
const { runClaudeShim } = entryMod;

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
