/**
 * pi runtime resolution — pure helpers shared by `entry-slow.mjs` and tests.
 *
 * The shim runs in its own Node process *outside* pi and must locate the
 * `@earendil-works/pi-coding-agent` package directory so jiti can alias the
 * bare specifier to pi's real install (see `entry-slow.mjs`). This module
 * contains only the candidate-gathering / validation logic and performs no
 * jiti loading, so it can be imported cheaply and unit-tested.
 *
 * Why so many candidates: a `pi install npm:...` package lives under
 * `~/.pi/agent/npm/node_modules/...`, which is NOT where the pi CLI itself is
 * installed. pi may live in a global npm root, a global *bun* root (hapi
 * runners are bun-compiled and often run from `~/.bun/install/global/bin`),
 * or a version-manager shim. Walking a fixed list of well-known roots is more
 * robust than any single assumption — and an explicit
 * `PICC_CLAUDE_SHIM_PI_DIR` override always wins.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PI_PKG = "@earendil-works/pi-coding-agent";
export const PI_MAIN_REL = join("dist", "index.js");

/** True when `dir` looks like a complete pi-coding-agent install. */
export function looksLikePiPkgDir(dir) {
  if (typeof dir !== "string" || dir.length === 0) return false;
  try {
    return existsSync(join(dir, PI_MAIN_REL)) && existsSync(join(dir, "package.json"));
  } catch {
    return false;
  }
}

/** Nearest `node_modules/<PI_PKG>` walking up from `fromDir` (dev checkouts). */
function walkUpForPiPkgDir(fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", PI_PKG);
    if (looksLikePiPkgDir(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/** `npm root -g` — where a global `npm i -g pi` install lives. */
export function npmGlobalRoot() {
  try {
    const root = execSync("npm root -g", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    })
      .toString()
      .trim();
    return root ? root : null;
  } catch {
    return null;
  }
}

/** Bun global roots: `$BUN_INSTALL/install/global/node_modules` (and `~/.bun`). */
function bunGlobalRoots(env) {
  const roots = [];
  const bunInstall = env.BUN_INSTALL;
  const candidates = [];
  if (bunInstall) candidates.push(join(bunInstall, "install", "global", "node_modules"));
  candidates.push(join(env.HOME ?? homedir(), ".bun", "install", "global", "node_modules"));
  for (const root of candidates) {
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

/**
 * Ordered list of candidate directories that might contain the pi runtime.
 * Not yet validated — callers filter with {@link looksLikePiPkgDir}.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] process env (defaults to `process.env`)
 * @param {string} [options.selfDir] directory of the caller (defaults to this file)
 * @param {string|null} [options.npmGlobalRoot] pre-resolved `npm root -g` (avoids a subprocess)
 */
export function candidatePiPkgDirs({ env = process.env, selfDir, npmGlobalRoot: providedNpmRoot } = {}) {
  // `fileURLToPath` (not `URL.pathname`) so the default is a real filesystem
  // path on every platform — `pathname` yields `/C:/...` on Windows, which
  // would break the "nearest local install" walk.
  const startDir = selfDir ?? dirname(fileURLToPath(import.meta.url));
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");

  const dirs = [];
  const add = (dir) => {
    if (typeof dir === "string" && dir.length > 0 && !dirs.includes(dir)) dirs.push(dir);
  };

  // 1. Explicit override always wins.
  add(env.PICC_CLAUDE_SHIM_PI_DIR);

  // 2. Nearest local install (dev checkout where pi is a devDependency).
  add(walkUpForPiPkgDir(startDir));

  // 3. Bun global roots (bun-compiled hapi runners commonly live here).
  for (const root of bunGlobalRoots(env)) add(join(root, PI_PKG));

  // 4. npm global root (only subprocesses when no explicit override/root given).
  if (!providedNpmRoot) {
    add(join(npmGlobalRoot() ?? "", PI_PKG));
  } else {
    add(join(providedNpmRoot, PI_PKG));
  }

  // 5. pi's own managed roots (covers pi installed into the agent's npm root).
  // Honor `env.HOME` so callers can keep the candidate list hermetic in tests.
  add(join(agentDir, "npm", "node_modules", PI_PKG));
  add(join(agentDir, "node_modules", PI_PKG));
  add(join(home, ".pi", "node_modules", PI_PKG));

  return dirs;
}

/**
 * Resolve the pi runtime directory by returning the first candidate that
 * passes {@link looksLikePiPkgDir}.
 *
 * @returns {string|null} absolute pi-coding-agent directory, or null
 */
export function resolvePiPkgDir({ env = process.env, selfDir } = {}) {
  for (const dir of candidatePiPkgDirs({ env, selfDir })) {
    if (looksLikePiPkgDir(dir)) return dir;
  }
  return null;
}
