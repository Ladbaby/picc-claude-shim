/**
 * Tests for the claude-skill discovery + expansion module (src/skills.ts).
 *
 * Covered (all pure / deterministic):
 *   - `parseArguments` — shell-ish arg tokenization (quotes, escapes).
 *   - `substituteArguments` — $ARGUMENTS, $ARGUMENTS[i], $i, named args, and
 *     the "append ARGUMENTS if no placeholder" fallback.
 *   - `expandSkill` — "Base directory" prefix + ${CLAUDE_SKILL_DIR} /
 *     ${CLAUDE_SESSION_ID} substitution (mirrors Claude Code getPromptForCommand).
 *   - `discoverSkills` / `resolveSkillExpansion` — real filesystem discovery
 *     under a temp CLAUDE_CONFIG_DIR (user scope wins; user-invocable filter;
 *     unknown name → null).
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseArguments,
  substituteArguments,
  expandSkill,
  discoverSkills,
  resolveSkillExpansion,
  type ClaudeSkill,
} from "../src/skills.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    process.stdout.write(`ok ${label}\n`);
  } else {
    process.stderr.write(`FAIL ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}\n`);
    failures += 1;
  }
}
function eq<T>(label: string, actual: T, expected: T): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  ok(label, pass, { expected, actual });
}

// ---------------------------------------------------------------------------
// parseArguments
// ---------------------------------------------------------------------------
eq("parseArguments: plain", parseArguments("foo bar baz"), ["foo", "bar", "baz"]);
eq("parseArguments: double-quoted", parseArguments('foo "hello world" baz'), ["foo", "hello world", "baz"]);
eq("parseArguments: single-quoted", parseArguments("foo 'hello world' baz"), ["foo", "hello world", "baz"]);
eq("parseArguments: escaped space", parseArguments('foo a\\ b baz'), ["foo", "a b", "baz"]);
eq("parseArguments: empty", parseArguments(""), []);
eq("parseArguments: whitespace only", parseArguments("   "), []);

// ---------------------------------------------------------------------------
// substituteArguments
// ---------------------------------------------------------------------------
eq("sub: $ARGUMENTS full", substituteArguments("hi $ARGUMENTS", "a b"), "hi a b");
eq("sub: $ARGUMENTS[i]", substituteArguments("x=$ARGUMENTS[0] y=$ARGUMENTS[1]", "a b"), "x=a y=b");
eq("sub: $i shorthand", substituteArguments("$0 and $1", "a b"), "a and b");
eq("sub: missing index → empty", substituteArguments("$0..$5", "a"), "a..");
eq("sub: no placeholder + args → append", substituteArguments("body", "a b"), "body\n\nARGUMENTS: a b");
eq("sub: no placeholder + empty args → unchanged", substituteArguments("body", ""), "body");
eq("sub: named args", substituteArguments("for $target", "target", ["target"]), "for target");
eq("sub: named missing → empty", substituteArguments("for $target", "", ["target"]), "for ");

// ---------------------------------------------------------------------------
// expandSkill
// ---------------------------------------------------------------------------
const fakeSkill: ClaudeSkill = {
  name: "demo",
  dir: "/tmp/demo-skill",
  body: "Use $ARGUMENTS to do ${CLAUDE_SKILL_DIR}/run and ${CLAUDE_SESSION_ID}.",
  argumentNames: [],
  userInvocable: true,
  scope: "user",
};
const expanded = expandSkill(fakeSkill, "the task", "sess-1");
ok("expand: Base directory prefix", expanded.startsWith("Base directory for this skill: /tmp/demo-skill\n\n"));
ok("expand: $ARGUMENTS substituted", expanded.includes("to do /tmp/demo-skill/run and sess-1."));
ok("expand: no leftover $ARGUMENTS", !expanded.includes("$ARGUMENTS"));
ok("expand: no leftover ${CLAUDE_SKILL_DIR}", !expanded.includes("${CLAUDE_SKILL_DIR}"));
ok("expand: no leftover ${CLAUDE_SESSION_ID}", !expanded.includes("${CLAUDE_SESSION_ID}"));

// ---------------------------------------------------------------------------
// discoverSkills / resolveSkillExpansion (real filesystem, temp config dir)
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "picc-skills-"));
try {
  // User scope: <tmp>/skills/demou/SKILL.md, plus a hidden one and a project dup.
  const userSkills = join(tmp, "skills");
  const demouDir = join(userSkills, "demou");
  mkdirSync(demouDir, { recursive: true });
  writeFileSync(
    join(demouDir, "SKILL.md"),
    "---\nname: demou\ndescription: demo user skill\n---\n\nUser body for $ARGUMENTS.",
  );
  // A skill with user-invocable: false must NOT be discoverable.
  const hiddenDir = join(userSkills, "secret");
  mkdirSync(hiddenDir, { recursive: true });
  writeFileSync(
    join(hiddenDir, "SKILL.md"),
    "---\nname: secret\nuser-invocable: false\n---\n\nhidden",
  );
  // A user skill with no SKILL.md is skipped.
  mkdirSync(join(userSkills, "empty"), { recursive: true });

  // Project scope (cwd): <tmp>/proj/.claude/skills/demou (dup → user wins) + projonly.
  const projRoot = join(tmp, "proj");
  const projSkills = join(projRoot, ".claude", "skills");
  const projDup = join(projSkills, "demou");
  mkdirSync(projDup, { recursive: true });
  writeFileSync(join(projDup, "SKILL.md"), "---\nname: demou\n---\n\nProject body (should be shadowed).");
  const projOnly = join(projSkills, "projonly");
  mkdirSync(projOnly, { recursive: true });
  writeFileSync(join(projOnly, "SKILL.md"), "---\nname: projonly\n---\n\nProject-only body.");

  // Point discovery at our temp user scope + the temp project cwd.
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;

  const skills = await discoverSkills(projRoot);
  eq("discover: names", [...skills.keys()].sort(), ["demou", "projonly"]);
  eq("discover: user scope wins for dup", skills.get("demou")?.dir, demouDir);
  eq("discover: user-invocable:false filtered out", skills.has("secret"), false);
  eq("discover: body stripped of frontmatter", skills.get("demou")?.body, "User body for $ARGUMENTS.");
  eq("discover: project skill present", skills.get("projonly")?.scope, "project");

  const exp = await resolveSkillExpansion(projRoot, "demou", "do it", "sess-9");
  ok("resolve: expands known skill", typeof exp === "string" && exp?.includes("User body for do it."));
  // expandSkill normalizes the base dir to forward slashes (Claude Code does the
  // same on Windows), so compare against the normalized form.
  ok(
    "resolve: Base directory is the USER copy",
    typeof exp === "string" && exp.includes("Base directory for this skill: " + demouDir.replace(/\\/g, "/")),
  );
  eq("resolve: unknown skill → null", await resolveSkillExpansion(projRoot, "nope", "", "s"), null);

  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------

process.on("exit", (code) => {
  if (failures > 0) {
    process.exitCode = 1;
  }
});
