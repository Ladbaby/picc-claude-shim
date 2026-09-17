/**
 * Claude-skill discovery + expansion, faithful to real Claude Code.
 *
 * Real Claude Code discovers skills from `<CLAUDE_CONFIG_DIR>/skills` (user
 * scope) and `<cwd>/.claude/skills` (project scope) — one directory per skill,
 * each holding a `SKILL.md` with YAML frontmatter. The skill's **invokable name
 * is its directory name** (not the frontmatter `name`). On name collision the
 * user-scope copy wins (it's listed first and is first-wins).
 *
 * On invocation the Claude Code harness expands `/name <args>` into a prompt:
 *
 *   "Base directory for this skill: <dir>\n\n" + SKILL.md body (frontmatter
 *   stripped), then substituting argument placeholders ($ARGUMENTS,
 *   $ARGUMENTS[i], $i, and frontmatter-declared named args) and
 *   ${CLAUDE_SKILL_DIR}, and appending "\n\nARGUMENTS: <args>" when no
 *   placeholder was present.
 *
 * See loadSkillsDir.ts (getPromptForCommand) and utils/argumentSubstitution.ts
 * in the reference. T3 rewrites a `$skill` mention into exactly that
 * `/skill <args>` text and sends it as an ordinary turn; the shim intercepts
 * it (entry.ts) and prompts pi with this expansion, so pi receives the same
 * prompt Claude Code would have built.
 *
 * Scope note: this mirrors only the two roots Claude Code *verifies* for skills
 * (user + cwd project). It intentionally does not scan `.agents/skills` —
 * Claude Code answers a skill that lives only there with "Unknown command", so
 * not expanding it here keeps the shim honest.
 */

import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";

/** A discovered, ready-to-expand skill. */
export interface ClaudeSkill {
  /** Invokable name — the skill's directory name. */
  readonly name: string;
  /** Absolute path to the skill directory (used for "Base directory" + ${CLAUDE_SKILL_DIR}). */
  readonly dir: string;
  /** The SKILL.md body with frontmatter stripped. */
  readonly body: string;
  /** Frontmatter `arguments` (named-argument positions), if any. */
  readonly argumentNames: string[];
  /** Frontmatter `user-invocable`; defaults to true. */
  readonly userInvocable: boolean;
  /** Which root the skill came from. */
  readonly scope: "user" | "project";
}

/**
 * The user-scope skills root, resolved exactly as T3 resolves it for the
 * spawned CLI: `$CLAUDE_CONFIG_DIR/skills`, else `~/.claude/skills`.
 *
 * (T3 exports `CLAUDE_CONFIG_DIR` to the claude process when the instance
 * config has a `homePath`; the shim inherits that env var, so this lands on the
 * same directory T3's `discoverClaudeSkills` scans — the picker and the
 * expansion agree on what exists.)
 */
export function userSkillsRoot(): string {
  const cfg = process.env.CLAUDE_CONFIG_DIR?.trim();
  const base = cfg && cfg.length > 0 ? cfg : join(homedir(), ".claude");
  return join(base, "skills");
}

/**
 * Project-scope skills roots: every `.claude/skills` from `cwd` up to (but NOT
 * including) the home directory — mirroring Claude Code's `getProjectDirsUpToHome`.
 * Stopping at home avoids re-scanning the user scope (which is `~/.claude/skills`
 * and is already handled by `userSkillsRoot`), and avoids walking past the user's
 * account into unrelated directories.
 */
export function projectSkillsRoots(cwd: string): string[] {
  const home = homedir();
  const roots: string[] = [];
  let dir = isAbsolute(cwd) ? cwd : process.cwd();
  for (;;) {
    if (dir === home) break; // home's own skills dir is user scope — stop
    roots.push(join(dir, ".claude", "skills"));
    const parent = join(dir, "..");
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return roots;
}

interface ParsedFrontmatter {
  readonly data: Record<string, string>;
  readonly body: string;
}

/**
 * Minimal YAML-frontmatter parse: the leading `---\n ... \n---\n` block as
 * flat `key: value` strings, plus the body that follows. Skills without a
 * frontmatter block load with an empty frontmatter (Claude Code treats
 * frontmatter as optional, falling back to a markdown-derived description).
 */
function parseFrontmatter(content: string): ParsedFrontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!m) {
    return { data: {}, body: content };
  }
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    let val = line.slice(idx + 1).trim();
    // Strip one pair of surrounding quotes, if present.
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    data[key] = val;
  }
  // Claude Code trims the leading blank line(s) between the frontmatter block
  // and the body.
  return { data, body: m[2].replace(/^\r?\n/, "") };
}

/** Parse the frontmatter `arguments` field (string or space-separated). */
function parseArgumentNames(raw: string | undefined): string[] {
  if (!raw) return [];
  const isValid = (n: string): boolean => n.trim() !== "" && !/^\d+$/.test(n);
  return raw
    .split(/\s+/)
    .filter(isValid);
}

/**
 * Lightweight shell-ish argument tokenizer, mirroring Claude Code's
 * `parseArguments` (shell-quote based) closely enough for the placeholder
 * cases that matter: respects `"..."` / `'...'` quoting and backslash escapes,
 * otherwise splits on whitespace.
 */
export function parseArguments(args: string): string[] {
  if (!args || !args.trim()) return [];
  const out: string[] = [];
  let cur = "";
  let active = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote === "'") {
      if (c === "'") {
        quote = null;
        continue;
      }
      cur += c; // single quotes are literal inside (no escapes)
    } else if (quote === '"') {
      if (c === "\\") {
        // Backslash escapes the next char inside double quotes.
        cur += args[i + 1] ?? "";
        i++;
        continue;
      }
      if (c === '"') {
        quote = null;
        continue;
      }
      cur += c;
    } else if (c === "\\" && i + 1 < args.length) {
      // Unquoted backslash escapes the next char (e.g. `a\ b` → "a b").
      cur += args[i + 1];
      i++;
      active = true;
    } else if (c === '"' || c === "'") {
      quote = c;
      active = true;
    } else if (/\s/.test(c)) {
      if (active) {
        out.push(cur);
        cur = "";
        active = false;
      }
    } else {
      cur += c;
      active = true;
    }
  }
  if (active) out.push(cur);
  return out;
}

/**
 * Substitute argument placeholders in content. Faithful port of Claude Code's
 * `substituteArguments`:
 *  - `$name` for frontmatter-declared names (position i → parsedArgs[i])
 *  - `$ARGUMENTS[i]` and `$i` for indexed args
 *  - `$ARGUMENTS` for the full raw args string
 *  - if no placeholder matched and `args` is non-empty, append
 *    `"\n\nARGUMENTS: <args>"`
 */
export function substituteArguments(
  content: string,
  args: string,
  argumentNames: readonly string[] = [],
): string {
  const parsedArgs = parseArguments(args);
  const originalContent = content;

  // Named arguments map to positions.
  for (let i = 0; i < argumentNames.length; i++) {
    const name = argumentNames[i];
    if (!name) continue;
    content = content.replace(
      new RegExp(`\\$${name}(?![\\[\\w])`, "g"),
      parsedArgs[i] ?? "",
    );
  }

  // Indexed arguments: $ARGUMENTS[0], $ARGUMENTS[1], …
  content = content.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, indexStr: string) => {
    const index = parseInt(indexStr, 10);
    return parsedArgs[index] ?? "";
  });

  // Shorthand indexed arguments: $0, $1, …
  content = content.replace(/\$(\d+)(?!\w)/g, (_, indexStr: string) => {
    const index = parseInt(indexStr, 10);
    return parsedArgs[index] ?? "";
  });

  // Full args.
  content = content.replaceAll("$ARGUMENTS", args);

  // Append if no placeholder was present.
  if (content === originalContent && args) {
    content = content + `\n\nARGUMENTS: ${args}`;
  }

  return content;
}

/**
 * Expand a discovered skill into the prompt Claude Code would send for
 * `/name <args>`. Mirrors `getPromptForCommand` in loadSkillsDir.ts:
 * the "Base directory" prefix, argument substitution, then ${CLAUDE_SKILL_DIR}
 * (and ${CLAUDE_SESSION_ID}) replacement.
 *
 * Note: Claude Code additionally executes inline `` !`…` `` bash injections in
 * the skill body before sending. The shim does not run them — it forwards the
 * (substituted) body as-is and lets pi's own agent run any such commands via
 * its tools. This is the correct behavior for a harness whose agent executes
 * tool calls itself.
 */
export function expandSkill(skill: ClaudeSkill, args: string, sessionId: string): string {
  const baseDir = process.platform === "win32" ? skill.dir.replace(/\\/g, "/") : skill.dir;
  let content = `Base directory for this skill: ${baseDir}\n\n${skill.body}`;
  content = substituteArguments(content, args, skill.argumentNames);
  content = content.replaceAll("${CLAUDE_SKILL_DIR}", baseDir);
  content = content.replaceAll("${CLAUDE_SESSION_ID}", sessionId);
  return content;
}

/** Load a single skill dir (a directory containing SKILL.md). */
async function loadSkill(
  dir: string,
  scope: "user" | "project",
): Promise<ClaudeSkill | null> {
  const file = join(dir, "SKILL.md");
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch {
    return null; // no SKILL.md here — not a skill
  }
  const { data, body } = parseFrontmatter(raw);
  const name = dir.split(/[\\/]/).filter(Boolean).pop()?.trim() ?? "";
  if (!name) return null;
  const userInvocable =
    data["user-invocable"] === undefined
      ? true
      : !(data["user-invocable"] === "false" || data["user-invocable"] === "0");
  return {
    name,
    dir,
    body,
    argumentNames: parseArgumentNames(data["arguments"]),
    userInvocable,
    scope,
  };
}

/**
 * Discover all invokable skills for a cwd, in the precedence order Claude Code
 * uses: user scope first, then project scope (shallowest to deepest). First
 * skill of a given name wins. Returns `userInvocable` skills only (those hidden
 * with `user-invocable: false` are model-invoked, not `/`-invoked, and T3
 * would not offer them in the picker either).
 */
export async function discoverSkills(cwd: string): Promise<Map<string, ClaudeSkill>> {
  const skills = new Map<string, ClaudeSkill>();
  const add = async (dir: string, scope: "user" | "project"): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // root doesn't exist — fine
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skill = await loadSkill(join(dir, entry.name), scope);
      if (skill && skill.userInvocable && !skills.has(skill.name)) {
        skills.set(skill.name, skill);
      }
    }
  };

  await add(userSkillsRoot(), "user");
  for (const root of projectSkillsRoots(cwd)) {
    await add(root, "project");
  }
  return skills;
}

/**
 * Resolve a `/name` invocation to its expanded prompt, or `null` when `name`
 * is not a known skill (the caller then falls through to a normal prompt, which
 * is the correct degradation for a genuine slash command pi doesn't know).
 */
export async function resolveSkillExpansion(
  cwd: string,
  name: string,
  args: string,
  sessionId: string,
): Promise<string | null> {
  const skill = await discoverSkills(cwd);
  const found = skill.get(name);
  if (!found) return null;
  return expandSkill(found, args, sessionId);
}
