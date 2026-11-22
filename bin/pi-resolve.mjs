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
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PI_PKG = "@earendil-works/pi-coding-agent";
export const PI_MAIN_REL = join("dist", "index.js");

/**
 * Bare specifiers pi's extension loader maps to its own copies of `typebox`
 * (see `getAliases()` in pi's `dist/core/extensions/loader.js`). The shim's
 * `src/` uses `typebox` as a *value* import (`ask-user-question.ts`), and it is
 * neither a dependency of this package nor installable here — inside pi the
 * loader provides the mapping, standalone we have to reproduce it.
 */
const TYPEBOX_PKGS = ["typebox", "@sinclair/typebox"];
const TYPEBOX_SUBPATHS = [
  "",
  "/compile",
  "/value",
  "/error",
  "/format",
  "/guard",
  "/schema",
  "/system",
  "/type",
];

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
 * Pi's managed installer stores the runtime in a versioned release directory:
 *
 *   <agentDir>/install/current-version
 *   <agentDir>/install/releases/<version>/node_modules/<PI_PKG>
 *
 * The `current-version` indirection is deliberate: pi updates atomically switch
 * releases and the launcher resolves the version at runtime. Read it rather
 * than guessing a release number. Invalid/missing files are ignored so this
 * remains only one candidate source among several.
 */
export function managedPiPkgDir(agentDir) {
  try {
    const installDir = join(agentDir, "install");
    const version = readFileSync(join(installDir, "current-version"), "utf8").trim();
    if (!/^[0-9A-Za-z._+-]+$/.test(version)) return null;
    return join(installDir, "releases", version, "node_modules", PI_PKG);
  } catch {
    return null;
  }
}

/**
 * Ordered list of candidate directories that might contain the pi runtime.
 * Not yet validated — callers filter with {@link looksLikePiPkgDir}.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] process env (defaults to `process.env`)
 * @param {string} [options.selfDir] directory of the caller (defaults to this file)
 * @param {string|null} [options.npmGlobalRoot] pre-resolved `npm root -g` (avoids a subprocess)
 * @param {boolean} [options.includeNpmGlobal] whether to probe `npm root -g` when no root is supplied
 */
export function candidatePiPkgDirs({
  env = process.env,
  selfDir,
  npmGlobalRoot: providedNpmRoot,
  includeNpmGlobal = true,
} = {}) {
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

  // 4. npm global root. The opt-out supports hermetic tests and callers that
  // already know a local/managed pi location; normal runtime resolution keeps
  // the established global-npm fallback.
  if (providedNpmRoot) {
    add(join(providedNpmRoot, PI_PKG));
  } else if (includeNpmGlobal) {
    add(join(npmGlobalRoot() ?? "", PI_PKG));
  }

  // 5. pi's managed runtime locations.
  // The normal managed installer places pi in `install/releases/<current>`;
  // npm/node_modules locations cover alternative/manual installs.
  add(managedPiPkgDir(agentDir));
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
export function resolvePiPkgDir({ env = process.env, selfDir, includeNpmGlobal = true } = {}) {
  for (const dir of candidatePiPkgDirs({ env, selfDir, includeNpmGlobal })) {
    if (looksLikePiPkgDir(dir)) return dir;
  }
  return null;
}

/**
 * Build the jiti alias entries that map `typebox` (and its subpaths) to pi's
 * own copy, mirroring pi's extension loader.
 *
 * `typebox` has no `main` field and resolves through `exports` subpaths, so
 * aliasing the bare directory does not work — jiti would fail deeper in the
 * graph (`Cannot find module '.../typebox/build/index.mjs/compile'`). Resolving
 * each specifier through a `createRequire` anchored at pi's `package.json`
 * yields real file paths and honours whatever `exports` map the installed
 * version declares. Subpaths the installed version does not export are simply
 * omitted, and any failure leaves the alias out so default resolution applies.
 *
 * The legacy `@sinclair/typebox` specifier is aliased to the same files when
 * neither the package nor pi ships that name — pi's loader does the same, so
 * extensions importing either name behave identically.
 *
 * @param {object} [options]
 * @param {string|null} [options.piDir] pi-coding-agent directory (see {@link resolvePiPkgDir})
 * @param {string[]} [options.packages] bare package names to alias
 * @param {string[]} [options.subpaths] subpath suffixes (`""` = the root entry)
 * @returns {Record<string, string>} specifier → absolute file path
 */
export function resolveTypeboxAliases({
  piDir,
  packages = TYPEBOX_PKGS,
  subpaths = TYPEBOX_SUBPATHS,
} = {}) {
  const aliases = {};
  if (typeof piDir !== "string" || piDir.length === 0) return aliases;
  let piRequire;
  try {
    piRequire = createRequire(join(piDir, "package.json"));
  } catch {
    return aliases;
  }
  for (const pkg of packages) {
    for (const subpath of subpaths) {
      const specifier = `${pkg}${subpath}`;
      try {
        aliases[specifier] = piRequire.resolve(specifier);
      } catch {
        // Not exported by this typebox version — leave it unaliased.
      }
    }
  }
  // pi aliases the legacy `@sinclair/typebox` specifier to its own `typebox`
  // copy. Recent installs ship only `typebox`, so fall back to that entry for
  // parity instead of silently leaving the legacy specifier unresolvable.
  for (const subpath of subpaths) {
    const legacy = `@sinclair/typebox${subpath}`;
    if (!aliases[legacy] && aliases[`typebox${subpath}`]) {
      aliases[legacy] = aliases[`typebox${subpath}`];
    }
  }
  return aliases;
}

/**
 * Full jiti alias map used by `entry-slow.mjs`: pi itself plus the `typebox`
 * copy that lives in pi's install.
 *
 * @param {string|null} piDir pi-coding-agent directory
 * @returns {Record<string, string>} specifier → path (empty when `piDir` is null)
 */
export function buildJitiAliases(piDir) {
  if (typeof piDir !== "string" || piDir.length === 0) return {};
  return { [PI_PKG]: piDir, ...resolveTypeboxAliases({ piDir }) };
}
