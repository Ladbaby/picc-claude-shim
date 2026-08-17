/**
 * Claude Code CLI flag parser.
 *
 * Mirrors the flag set used by `claude-code/entrypoints/cli.tsx` and the
 * specific subset exercised by `hapi/cli/src/claude/sdk/query.ts` in its
 * SDK path.
 *
 * The output is a normalized `ClaudeShimOptions` consumed by `entry.ts`.
 *
 * The parser does NOT pull in commander.js — we keep dependencies tight
 * (the shim ships inside the user's pi config tree and is invoked as a
 * Node.js script; we want a single transitive dep, pi itself).
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "auto"
  | "load"
  | "save";

export type ClaudeOutputFormat = "stream-json" | "json" | "text";

export interface ClaudeShimOptions {
  /** Raw argv after stripping `pi claude-shim` (or the `claude` shim entry). */
  rawArgv: string[];

  // Flags
  outputFormat: ClaudeOutputFormat | undefined;
  inputFormat: "stream-json" | undefined;
  verbose: boolean;
  systemPrompt: string | undefined;
  appendSystemPrompt: string | undefined;
  permissionPromptTool: "stdio" | undefined;
  resume: string | undefined;
  continueConversation: boolean;
  settingsPath: string | undefined;
  allowedTools: string[];
  disallowedTools: string[];
  addDirs: string[];
  permissionMode: ClaudePermissionMode | undefined;
  model: string | undefined;
  effort: string | undefined;
  fallbackModel: string | undefined;
  maxTurns: number | undefined;
  printPrompt: string | undefined;

  // Bookkeeping
  help: boolean;
  version: boolean;
  unrecognized: string[];
}

const KNOWN_FLAGS = new Set([
  "--output-format",
  "--input-format",
  "--verbose",
  "--system-prompt",
  "--append-system-prompt",
  "--permission-prompt-tool",
  "--resume",
  "--continue",
  "--settings",
  "--allowedTools",
  "--disallowedTools",
  "--add-dir",
  "--permission-mode",
  "--model",
  "--effort",
  "--fallback-model",
  "--max-turns",
  "--print",
  "--help",
  "--version",
]);

const SHORT_FLAGS = new Set(["-v", "-h", "-p"]);

/**
 * Parse Claude-Code-style argv into structured options. The output mimics
 * the subset that hapi (`cli/src/claude/sdk/query.ts`) and the broader
 * Claude surface exercise on the wire.
 */
export function parseClaudeArgs(argv: readonly string[]): ClaudeShimOptions {
  const opts: ClaudeShimOptions = {
    rawArgv: [...argv],
    outputFormat: undefined,
    inputFormat: undefined,
    verbose: false,
    systemPrompt: undefined,
    appendSystemPrompt: undefined,
    permissionPromptTool: undefined,
    resume: undefined,
    continueConversation: false,
    settingsPath: undefined,
    allowedTools: [],
    disallowedTools: [],
    addDirs: [],
    permissionMode: undefined,
    model: undefined,
    effort: undefined,
    fallbackModel: undefined,
    maxTurns: undefined,
    printPrompt: undefined,
    help: false,
    version: false,
    unrecognized: [],
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;

    if (arg === "--") {
      // Positional separator; drop the rest into `unrecognized` for
      // surfacing if needed. The shim does not support subcommands
      // beyond what hapi sends.
      opts.unrecognized.push(...argv.slice(i));
      break;
    }

    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      i++;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      opts.version = true;
      i++;
      continue;
    }

    // -p / --print: may be `--print <prompt>` or `-p <prompt>` or
    // `--print=<prompt>` (rare). hapi's query.ts passes
    // `--print "<prompt>"` only after pre-joining, so two args (or one
    // `--print=...`) is the expected shape.
    if (arg === "-p" || arg === "--print") {
      const next = argv[i + 1];
      if (next === undefined) {
        // hapi's --print always carries a value; treat bare `-p` as no-op
        // for safety.
        i++;
        continue;
      }
      opts.printPrompt = next;
      i += 2;
      continue;
    }
    if (arg.startsWith("--print=")) {
      opts.printPrompt = arg.slice("--print=".length);
      i++;
      continue;
    }

    // Boolean flag with one-token form (no value follows)
    if (arg === "--verbose" || arg === "-d" || arg === "--continue") {
      if (arg === "--verbose") opts.verbose = true;
      if (arg === "--continue") opts.continueConversation = true;
      i++;
      continue;
    }

    // Flags that take an inline `=` value or next-token value
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const inline = parseInlineEq(arg);
    if (inline) {
      const value = inline.value;
      applyFlag(opts, inline.flag, value);
      i++;
      continue;
    }

    // Discrete flags
    if (KNOWN_FLAGS.has(arg)) {
      const next = argv[i + 1];
      if (next === undefined) {
        // Tolerate missing values; mark as unrecognized for logging
        opts.unrecognized.push(arg);
        i++;
        continue;
      }
      applyFlag(opts, arg, next);
      i += 2;
      continue;
    }

    if (SHORT_FLAGS.has(arg)) {
      opts.unrecognized.push(arg);
      i++;
      continue;
    }

    // Unknown flag
    opts.unrecognized.push(arg);
    i++;
  }

  return opts;
}

/**
 * Parse `--flag=value` form. Returns `{flag, value}` or null.
 */
function parseInlineEq(arg: string): { flag: string; value: string } | null {
  if (!arg.startsWith("--")) return null;
  const eq = arg.indexOf("=");
  if (eq < 0) return null;
  const flag = arg.slice(0, eq);
  const value = arg.slice(eq + 1);
  if (!KNOWN_FLAGS.has(flag)) return null;
  return { flag, value };
}

function applyFlag(opts: ClaudeShimOptions, flag: string, raw: string): void {
  switch (flag) {
    case "--output-format":
      if (raw === "stream-json" || raw === "json" || raw === "text") {
        opts.outputFormat = raw;
      }
      break;
    case "--input-format":
      if (raw === "stream-json") opts.inputFormat = "stream-json";
      break;
    case "--system-prompt":
      opts.systemPrompt = raw;
      break;
    case "--append-system-prompt":
      opts.appendSystemPrompt = raw;
      break;
    case "--permission-prompt-tool":
      if (raw === "stdio") opts.permissionPromptTool = "stdio";
      break;
    case "--resume":
      opts.resume = raw;
      break;
    case "--settings":
      opts.settingsPath = raw;
      break;
    case "--allowedTools":
      opts.allowedTools = splitCsv(raw);
      break;
    case "--disallowedTools":
      opts.disallowedTools = splitCsv(raw);
      break;
    case "--add-dir":
      // hapi passes single-dir-per-flag, but Claude itself supports
      // multiple; we accept both via repeated flags.
      opts.addDirs.push(raw);
      break;
    case "--permission-mode":
      opts.permissionMode = normalizePermissionMode(raw);
      break;
    case "--model":
      opts.model = raw;
      break;
    case "--effort":
      opts.effort = raw;
      break;
    case "--fallback-model":
      opts.fallbackModel = raw;
      break;
    case "--max-turns":
      opts.maxTurns = parseIntOrUndefined(raw);
      break;
    default:
      opts.unrecognized.push(flag, raw);
      break;
  }
}

function splitCsv(s: string): string[] {
  // Claude accepts comma-separated, also tolerates spaces. Empty entries
  // are dropped.
  return s
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function parseIntOrUndefined(s: string): number | undefined {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function normalizePermissionMode(raw: string): ClaudePermissionMode | undefined {
  switch (raw) {
    case "default":
    case "acceptEdits":
    case "bypassPermissions":
    case "plan":
    case "auto":
    case "load":
    case "save":
      return raw;
    default:
      return undefined;
  }
}

/**
 * Map Claude's `--effort` (Anthropic-style: max | high | medium | low |
 * minimal) onto pi's ThinkingLevel. Defaults to "off" when unknown.
 */
export function effortToThinkingLevel(effort: string | undefined): ThinkingLevel {
  if (!effort) return "off";
  switch (effort.toLowerCase()) {
    case "max":
      return "max";
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    case "minimal":
      return "minimal";
    default:
      return "off";
  }
}

/**
 * Print the shim's Claude-shaped --help text.
 *
 * The shim is invoked as a stand-in for `claude` and a small subset of
 * hapi's flags is the contract. Surfaces the supported flags plus
 * Claude-shaped wording (so a `claude --help` looks plausible to a
 * debugging operator).
 */
export function printClaudeShapedHelp(): void {
  const text = [
    "Usage: claude [options]",
    "",
    "Options:",
    "  -p, --print <prompt>           Print response and exit (non-interactive).",
    "  --output-format <fmt>          Output format: text|json|stream-json.",
    "  --input-format <fmt>           Input format: stream-json.",
    "  --verbose                      Verbose logging.",
    "  --system-prompt <text>         Replace the system prompt.",
    "  --append-system-prompt <text>  Append to the system prompt.",
    "  --permission-prompt-tool stdio Enable tool permission prompts over stdio.",
    "  --resume <session-id>          Resume a previous session.",
    "  --continue                     Continue the most recent session.",
    "  --settings <path>              Settings JSON path (logged, not parsed).",
    "  --allowedTools <a,b>           Comma-separated tool allowlist.",
    "  --disallowedTools <a,b>        Comma-separated tool blocklist.",
    "  --add-dir <path>               Add a directory for tool access (repeatable).",
    "  --permission-mode <mode>       default|acceptEdits|bypassPermissions|plan|auto.",
    "  --model <id>                   Model identifier.",
    "  --effort <level>               max|high|medium|low|minimal.",
    "  --fallback-model <id>          Fallback model on primary failure.",
    "  --max-turns <n>                Maximum agentic turns.",
    "  -h, --help                     Show this help.",
    "  -v, --version                  Print version.",
    "",
    "Drop-in replacement for Claude Code's CLI backed by pi.",
    "Local (interactive) mode is not supported; this binary speaks",
    "the stream-json protocol that the hapi integration uses.",
  ].join("\n");
  process.stdout.write(text + "\n");
}
