/**
 * Slow-path loader for the Claude shim.
 *
 * Loaded by `bin/claude.js` *only* after the `--version`/`--help` fast paths
 * have been ruled out. This is where we pull in the full pi runtime (via jiti
 * transpiling `../src/entry.ts`). Keeping the heavy import here — rather than
 * as a top-level static import in `claude.js` — is what makes `claude --version`
 * answer in milliseconds (T3 Code's probe allows only 4s).
 *
 * Resolving the pi runtime
 * ------------------------
 * This binary runs in its own Node process, *outside* pi. The only runtime
 * (value) import the shim makes against pi is `@earendil-works/pi-coding-agent`
 * (in `src/entry.ts`); every other pi import in `src/` is `import type` and is
 * erased at transpile time.
 *
 * When the shim is installed with `pi install npm:...`, pi runs
 * `npm install --legacy-peer-deps`, which does NOT install our
 * `peerDependencies` (the pi packages are provided by the pi host, not bundled).
 * So `@earendil-works/pi-coding-agent` is not resolvable from this package's own
 * `node_modules`. We instead **reuse pi's own install** by aliasing the bare
 * specifier to the directory where pi is actually installed. jiti applies the
 * alias at resolution time and loads pi's ESM entry through its native-import
 * path. `pi-ai` / `pi-agent-core` / `pi-tui` ride along automatically because
 * pi-coding-agent declares them as its own dependencies.
 *
 * Discovery order for pi's install directory:
 *   1. `PICC_CLAUDE_SHIM_PI_DIR` (explicit override — the
 *      `@earendil-works/pi-coding-agent` package directory),
 *   2. the nearest `node_modules/@earendil-works/pi-coding-agent` walking up from
 *      this file (a local dev checkout where pi is a devDependency),
 *   3. the global npm root (`npm root -g`) — where a normal global `pi` install
 *      lives.
 */

import { createJiti } from "jiti";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PI_PKG = "@earendil-works/pi-coding-agent";
const PI_MAIN_REL = join("dist", "index.js");

function looksLikePiPkgDir(dir) {
  return existsSync(join(dir, PI_MAIN_REL)) && existsSync(join(dir, "package.json"));
}

/** Nearest `node_modules/<PI_PKG>` walking up from this file (dev checkout). */
function localPiPkgDir() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "node_modules", PI_PKG);
    if (looksLikePiPkgDir(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/** `npm root -g` / `@earendil-works/pi-coding-agent` — a global pi install. */
function globalPiPkgDir() {
  try {
    const root = execSync("npm root -g", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    })
      .toString()
      .trim();
    const candidate = join(root, PI_PKG);
    if (looksLikePiPkgDir(candidate)) return candidate;
  } catch {
    // npm not usable or pi not installed globally — fall through.
  }
  return null;
}

function resolvePiPkgDir() {
  const override = process.env.PICC_CLAUDE_SHIM_PI_DIR;
  if (override && looksLikePiPkgDir(override)) return override;

  const local = localPiPkgDir();
  if (local) return local;

  return globalPiPkgDir();
}

function buildJiti() {
  const options = { interopDefault: true };
  const piDir = resolvePiPkgDir();
  if (piDir) {
    // Alias the bare specifier to pi's install directory so its own `main`
    // / `exports` (ESM `dist/index.js`) are used, and its nested deps resolve
    // against pi's own `node_modules`.
    options.alias = { [PI_PKG]: piDir };
  }
  return createJiti(import.meta.url, options);
}

let entryMod;
try {
  const jiti = buildJiti();
  entryMod = jiti("../src/entry.ts");
} catch (err) {
  // If we could not locate pi's install, the error is almost certainly a
  // module-resolution failure for the pi package. Surface the override hint.
  const isResolution =
    /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED/.test(
      (err && err.message) || "",
    );
  if (isResolution && !resolvePiPkgDir()) {
    throw new Error(
      [
        "could not resolve the pi runtime (@earendil-works/pi-coding-agent) to load the Claude shim.",
        "",
        "This happens when the shim's package is installed with `pi install npm:...`, which",
        "does not bundle the pi peer dependencies. Point the shim at your pi install with:",
        "",
        "  PICC_CLAUDE_SHIM_PI_DIR=<path>/node_modules/@earendil-works/pi-coding-agent",
        "",
        `(set this in the environment of the process that spawns \`claude\`, or install pi`,
        `globally so \`npm root -g\` can find it. Original error: ${
          (err && err.message).split("\n")[0]
        })`,
      ].join("\n"),
    );
  }
  throw err;
}

export const runClaudeShim = entryMod.runClaudeShim;
