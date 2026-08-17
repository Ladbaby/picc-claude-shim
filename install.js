#!/usr/bin/env node
/**
 * Postinstall helper for pi-claude-shim.
 *
 * Registers the extension in `~/.pi/agent/settings.json#packages`
 * (idempotently) and writes `claude.cmd` (and the POSIX `claude`
 * entry) into a directory on the user's PATH so `claude` is
 * auto-discoverable by `hapi`.
 *
 * Run manually any time with `node install.js` to (re-)write the
 * binary wrappers.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SHIM_ROOT = __dirname;
const AGENT_DIR = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");

function log(...args) {
  process.stderr.write("[pi-claude-shim/install] " + args.join(" ") + "\n");
}

function main() {
  // 1. Register the extension in settings.json.
  registerExtension();

  // 2. Pick a binary install dir.
  const binDir = pickBinDir();
  if (!binDir) {
    log(
      "could not find a writable directory on PATH; claude.cmd shim must be invoked via HAPI_CLAUDE_PATH.",
    );
    process.exit(0); // not fatal
  }

  mkdirSync(binDir, { recursive: true });

  const cmdTarget = join(binDir, "claude.cmd");
  const posixTarget = join(binDir, "claude");

  writeCmdShim(cmdTarget);
  writePosixShim(posixTarget);

  log(`installed: ${cmdTarget}`);
  log(`installed: ${posixTarget}`);
  log("verify with:  claude --version");
}

function registerExtension() {
  if (!existsSync(SETTINGS_PATH)) {
    log(`settings.json not found at ${SETTINGS_PATH} — skipping registration.`);
    return;
  }
  const raw = readFileSync(SETTINGS_PATH, "utf-8");
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch (e) {
    log(`could not parse settings.json: ${e.message}; skipping registration.`);
    return;
  }
  settings.packages = settings.packages ?? [];
  // Idempotent check: an existing entry referencing our exact folder
  // counts as registered. (pi-claude-shimmer collides on substring
  // alone, so we use whole-string match.)
  const localEntry = `extensions/pi-claude-shim`;
  const already = settings.packages.some(
    (p) => typeof p === "string" && p === localEntry,
  );
  if (!already) {
    settings.packages.push(localEntry);
    try {
      writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
      log(`added ${localEntry} to settings.json#packages`);
    } catch (e) {
      log(`failed to update settings.json: ${e.message}`);
    }
  }
}

/**
 * Find a directory already on PATH that we can write to. Precedence:
 *
 *   1. $LOCALAPPDATA/Programs/claude (preferred on Windows since
 *      Claude Code itself installs there)
 *   2. ~/.local/bin (cross-platform default for user-local tools)
 *   3. The first PATH entry we can write to
 */
function pickBinDir() {
  const candidates = [];
  // Prefer ~/.local/bin (cross-platform, no risk of clobbering a real
  // install) and ~/bin (an older convention). The user's local
  // AppData/Programs/<app> directory is reserved for the app's own
  // binaries and must NOT host our shim because it would overwrite a
  // real Claude Code install on Windows.
  candidates.push(join(homedir(), ".local", "bin"));
  candidates.push(join(homedir(), "bin"));

  for (const c of candidates) {
    if (isWritable(c)) return c;
  }

  return null;
}

function isWritable(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a `claude.cmd` shim that forwards to this shim's
 * `bin/claude.js` (which itself imports `entry.ts` via jiti).
 *
 * The placeholder `__SHIM_BIN_PLACEHOLDER__` in the source template is
 * substituted with the absolute path of the source `bin/claude.js`
 * before being written to the install target.
 */
function writeCmdShim(target) {
  // Refuse to overwrite an existing Claude Code install. We only
  // drop our shim into a directory where no real `claude` / `claude.cmd`
  // exists yet. Pass --force to override.
  if (existsSync(target) && !process.argv.includes("--force")) {
    // Idempotent re-run: if the existing file is *our* shim, leave it.
    try {
      const existing = readFileSync(target, "utf-8");
      if (existing.includes("__SHIM_BIN_PLACEHOLDER__")) {
        // Has a placeholder: regenerate against the current tree.
      } else if (existing.startsWith("@echo off")) {
        log(`re-using existing shim at ${target}`);
        return;
      } else {
        log(
          `refusing to overwrite non-shim file ${target}. ` +
            "Pass --force to override.",
        );
        return;
      }
    } catch {
      log(`could not read existing shim ${target}; leaving untouched`);
      return;
    }
  }
  const template = readFileSync(join(SHIM_ROOT, "bin", "claude.cmd"), "utf-8");
  const shimBinAbs = join(SHIM_ROOT, "bin", "claude.js");
  const filled = template.replace("__SHIM_BIN_PLACEHOLDER__", shimBinAbs);
  writeFileSync(target, filled);
}

/**
 * Write a POSIX `claude` shim. On Windows it's still useful if the
 * user is using WSL or git-bash.
 */
function writePosixShim(target) {
  if (process.platform === "win32" && !process.env.PI_SHIM_POSIX) {
    return; // skip on Windows unless explicitly requested
  }
  const content = [
    "#!/usr/bin/env bash",
    "# Auto-generated by pi-claude-shim/install.js",
    "set -euo pipefail",
    `exec node "${join(SHIM_ROOT, "bin", "claude.js")}" "$@"\n`,
  ].join("\n");
  writeFileSync(target, content);
  try {
    chmodSync(target, 0o755);
  } catch {
    /* best-effort on Windows */
  }
}

main();
