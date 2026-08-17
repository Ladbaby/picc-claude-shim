/**
 * Tool name mapping between pi's lowercase tool names and Anthropic /
 * Claude Code's PascalCase names. Modulo case for built-ins.
 *
 * - `toClaudeToolName(piName)`: emits the name on Claude wire protocol
 *   in `assistant.content[].tool_use.name`.
 * - `fromClaudeToolName(claudeName)`: resolves a name from
 *   `control_request.request.tool_name` to pi's tool name.
 * - `isSupportedClaudeToolName(claudeName)`: does pi have a built-in
 *   that corresponds to this Claude tool?
 *
 * Unknown tools are rejected in the permission gate.
 */

export type PiToolName =
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "grep"
  | "find"
  | "ls";

export type ClaudeToolName =
  | "Read"
  | "Write"
  | "Edit"
  | "Bash"
  | "Grep"
  | "Glob"
  | "LS";

/** pi name → Claude/Anthropic name. Identity modulo case for built-ins. */
export function toClaudeToolName(piName: string): string {
  return piName.charAt(0).toUpperCase() + piName.slice(1);
}

/** Claude/Anthropic name → pi name. Identity modulo case for built-ins. */
export function fromClaudeToolName(claudeName: string): string | null {
  const lower = claudeName.toLowerCase();
  switch (lower) {
    case "read":
    case "write":
    case "edit":
    case "bash":
    case "grep":
    case "find":
    case "ls":
      return lower;
    default:
      return null;
  }
}

export function isSupportedClaudeToolName(claudeName: string): boolean {
  return fromClaudeToolName(claudeName) !== null;
}

/**
 * Translate the wire-format tool name as hapi / Claude delivers it.
 * Accepts both PascalCase ("Bash") and lowercase ("bash") tolerant.
 */
export function normalizeIncomingToolName(raw: string): string {
  const piName = fromClaudeToolName(raw);
  return piName ?? raw.toLowerCase();
}
