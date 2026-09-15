/**
 * Hapi-compatible session JSONL writer.
 *
 * hapi spawns `claude` and waits for a session JSONL file to materialize
 * at this exact path:
 *
 *     $CLAUDE_CONFIG_DIR/projects/$projectId/$sessionId.jsonl
 *
 * where `projectId` is the absolute cwd with every non-alphanumeric char
 * replaced by `-`. The directory defaults to `~/.claude/projects/<id>/`.
 *
 * hapi's session scanner (`cli/src/claude/utils/claudeCheckSession.ts`)
 * reads the file line-by-line and checks each line is a JSON object with
 * a string `uuid` field. The schema in `cli/src/claude/types.ts`
 * documents the rest.
 *
 * We mirror that schema here so hapi reads the same shape that Claude
 * Code itself emits, even though we are actually running pi under the
 * hood.
 */

import { mkdirSync, existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { CLAUDE_CODE_VERSION_BARE } from "./version.js";

export interface SessionFileOptions {
  /** hapi spawns claude in this directory; we mimic the path it expects. */
  cwd: string;
  /** The pi session id becomes the hapi session id verbatim. */
  sessionId: string;
  /** Model identifier used in the `system` line. */
  modelId?: string;
  /** Override the CLAUDE_CONFIG_DIR env var; defaults to $CLAUDE_CONFIG_DIR || ~/.claude */
  claudeConfigDir?: string;
}

/**
 * Compute the path of the session JSONL file hapi is waiting on. Matches
 * `hapi/cli/src/claude/utils/path.ts#getProjectPath` exactly.
 */
export function computeHapiProjectDir(
  cwd: string,
  claudeConfigDir?: string,
): string {
  const projectId = resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  const cfgDir = claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(cfgDir, "projects", projectId);
}

export function computeHapiSessionPath(
  cwd: string,
  sessionId: string,
  claudeConfigDir?: string,
): string {
  return join(computeHapiProjectDir(cwd, claudeConfigDir), `${sessionId}.jsonl`);
}

/**
 * Replace a path string with the on-disk equivalent. Cross-platform: on
 * Windows the drive letter is normalized, and any path is resolved to
 * absolute so subsequent file operations are unambiguous.
 */
function ensureAbsolute(p: string): string {
  return isAbsolute(p) ? p : resolve(p);
}

export interface SessionFileState {
  sessionId: string;
  path: string;
  projectDir: string;
}

/**
 * Create the project dir if missing and write the initial
 * `session_meta` line (which is recognized by `claudeCheckSession` because
 * it carries a `uuid`). Idempotent — if the file already exists with
 * content we DO NOT overwrite it (hapi-managed resumes must survive).
 */
export function ensureHapiCompatibleSessionFile(
  opts: SessionFileOptions,
): SessionFileState {
  const projectDir = computeHapiProjectDir(opts.cwd, opts.claudeConfigDir);
  const filePath = join(projectDir, `${opts.sessionId}.jsonl`);

  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  if (!existsSync(filePath)) {
    // hapi's claudeCheckSession only requires one line with a string
    // `uuid`; we emit a session_meta entry that also carries the model
    // and cwd so the Web UI has something to render.
    const meta = {
      type: "session_meta",
      uuid: randomUUID(),
      sessionId: opts.sessionId,
      model: opts.modelId ?? "unknown",
      cwd: ensureAbsolute(opts.cwd),
      timestamp: new Date().toISOString(),
    };
    appendFileSync(filePath, JSON.stringify(meta) + "\n", "utf-8");
  }

  return {
    sessionId: opts.sessionId,
    path: filePath,
    projectDir,
  };
}

export interface AppendSessionEntryInput {
  kind: "user" | "assistant" | "system" | "summary" | "tool_result";
  parentUuid?: string | null;
  message: unknown;
  sessionId: string;
  cwd?: string;
  model?: string;
  extra?: Record<string, unknown>;
}

/**
 * Append a single JSONL entry to the session file. Each entry carries a
 * unique `uuid` so hapi's scanner accepts it and so the hub/tree
 * machinery has unique IDs.
 */
export function appendSessionEntry(
  state: SessionFileState,
  input: AppendSessionEntryInput,
): string {
  const uuid = randomUUID();
  const entry: Record<string, unknown> = {
    uuid,
    parentUuid: input.parentUuid ?? null,
    isSidechain: false,
    userType: "external",
    cwd: input.cwd ?? "",
    sessionId: input.sessionId,
    version: "0.0.1-pi-claude-shim",
    timestamp: new Date().toISOString(),
    type: input.kind,
    message: input.message,
    ...(input.extra ?? {}),
  };

  appendFileSync(state.path, JSON.stringify(entry) + "\n", "utf-8");
  return uuid;
}
