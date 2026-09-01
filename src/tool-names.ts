/**
 * Tool name mapping between pi's (picc) tool names and Anthropic /
 * Claude Code's PascalCase wire names.
 *
 * picc registers its tools with `config.json` `toolName` values that may be
 * lowercase (`read`, `bash`, `grep`) or PascalCase (`Read`, `Glob`, `Edit`).
 * Both spellings are valid, so every mapping here is **case-insensitive** in
 * both directions.
 *
 * - `toClaudeToolName(piName)`: emits the name on the Claude wire protocol in
 *   `assistant.content[].tool_use.name` (PascalCase).
 * - `fromClaudeToolName(claudeName)`: resolves a name from
 *   `control_request.request.tool_name` (either case) to pi's canonical tool
 *   name (lowercase for built-ins), or null if pi has no such tool.
 * - `isSupportedClaudeToolName(claudeName)`: does picc have a built-in that
 *   corresponds to this Claude tool?
 *
 * The only non-identity mapping is pi `find` ↔ Claude `Glob`: picc-glob
 * accepts both `Glob` and `find`, while Claude Code names the equivalent tool
 * `Glob`.
 */

/** picc tool names that pi recognizes (canonical lowercase). */
export type PiToolName =
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "grep"
  | "find"
  | "ls";

/** Claude / Anthropic wire names for the built-ins (PascalCase). */
export type ClaudeToolName =
  | "Read"
  | "Write"
  | "Edit"
  | "Bash"
  | "Grep"
  | "Glob"
  | "LS";

/** pi canonical (lowercase) → Claude wire name. */
const PI_TO_CLAUDE: Record<PiToolName, ClaudeToolName> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  find: "Glob",
  ls: "LS",
};

/** Reverse lookup: Claude wire name (lowercased) → pi canonical name. */
const CLAUDE_TO_PI: Record<string, PiToolName> = Object.fromEntries(
  Object.entries(PI_TO_CLAUDE).map(([pi, claude]) => [claude.toLowerCase(), pi]),
) as Record<string, PiToolName>;

function firstUpper(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * pi name → Claude/Anthropic wire name. Case-insensitive: `Read` and `read`
 * both map to `Read`. Unknown names are capitalized as a best effort so the
 * protocol always carries a plausible tool name.
 */
export function toClaudeToolName(piName: string): string {
  const canonical = PI_TO_CLAUDE[piName.toLowerCase() as PiToolName];
  if (canonical) return canonical;
  // Fallback: unknown tool — capitalize for a plausible PascalCase name.
  return firstUpper(piName.toLowerCase());
}

/**
 * Claude/Anthropic wire name → pi canonical (lowercase) name.
 * Case-insensitive: `Glob`/`glob`/`GLOB` all resolve to `find` (pi's name for
 * the Glob tool). Returns null for names pi does not have a built-in for.
 */
export function fromClaudeToolName(claudeName: string): string | null {
  return CLAUDE_TO_PI[claudeName.toLowerCase()] ?? null;
}

export function isSupportedClaudeToolName(claudeName: string): boolean {
  return fromClaudeToolName(claudeName) !== null;
}

/**
 * Translate an incoming wire tool name to pi's canonical name. Accepts both
 * PascalCase ("Grep") and lowercase ("grep"). Falls back to the lowercased
 * input for unknown tools so a name is always produced.
 */
export function normalizeIncomingToolName(raw: string): string {
  const piName = fromClaudeToolName(raw);
  return piName ?? raw.toLowerCase();
}
