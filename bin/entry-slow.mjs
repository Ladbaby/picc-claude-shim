/**
 * Slow-path loader for the Claude shim.
 *
 * Loaded by `bin/claude.js` *only* after the `--version`/`--help` fast paths
 * and the no-prompt capability probe have been ruled out. This is where we
 * pull in the full pi runtime (via jiti transpiling `../src/entry.ts`).
 * Keeping the heavy import here — rather than as a top-level static import in
 * `claude.js` — is what makes `claude --version` answer in milliseconds.
 *
 * Resolving the pi runtime
 * ------------------------
 * This binary runs in its own Node process, *outside* pi. The only runtime
 * (value) import the shim makes against pi is
 * `@earendil-works/pi-coding-agent` (in `src/entry.ts`); every other pi import
 * in `src/` is `import type` and is erased at transpile time.
 *
 * When the shim is installed with `pi install npm:...`, pi runs
 * `npm install --legacy-peer-deps`, which does NOT install our
 * `peerDependencies` (the pi packages are provided by the pi host, not
 * bundled). So `@earendil-works/pi-coding-agent` is not resolvable from this
 * package's own `node_modules`. We instead **reuse pi's own install** by
 * aliasing the bare specifier to the directory where pi is actually
 * installed. jiti applies the alias at resolution time and loads pi's ESM
 * entry through its native-import path. `pi-ai` / `pi-agent-core` /
 * `pi-tui` ride along automatically because pi-coding-agent declares them as
 * its own dependencies.
 *
 * Discovery is centralized in {@link ./pi-resolve.mjs} so it can be tested
 * independently. In short, the first match wins:
 *   1. `PICC_CLAUDE_SHIM_PI_DIR` (explicit override — the
 *      `@earendil-works/pi-coding-agent` package directory),
 *   2. the nearest `node_modules/@earendil-works/pi-coding-agent` walking up
 *      from this file (a local dev checkout where pi is a devDependency),
 *   3. a Bun global root (`$BUN_INSTALL/install/global/node_modules`,
 *      `~/.bun/install/global/node_modules`) — bun-compiled hapi runners
 *      commonly live here,
 *   4. the npm global root (`npm root -g`),
 *   5. pi's own managed roots (`~/.pi/agent/npm/node_modules`,
 *      `~/.pi/agent/node_modules`, `~/.pi/node_modules`).
 */

import { createJiti } from "jiti";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLauncher } from "../installer-lib.mjs";
import { resolvePiPkgDir } from "./pi-resolve.mjs";

const PI_PKG = "@earendil-works/pi-coding-agent";

// Make sure the documented, deterministic launcher directory exists even when
// the package's postinstall hook did not run. This is network-free and
// swallows errors, so it can never delay or break a session. Skipped when a
// test explicitly opts out (PICC_CLAUDE_SHIM_DISABLE_SELF_INSTALL=1).
if (!process.env.PICC_CLAUDE_SHIM_DISABLE_SELF_INSTALL) {
  ensureLauncher({ shimRoot: dirname(dirname(fileURLToPath(import.meta.url))) });
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
  entryMod = jiti(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "entry.ts"));
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
        "does not bundle the pi peer dependencies, and none of the well-known pi locations",
        "contain a usable install. Point the shim at your pi install with:",
        "",
        "  PICC_CLAUDE_SHIM_PI_DIR=<path>/node_modules/@earendil-works/pi-coding-agent",
        "",
        `(set this in the environment of the process that spawns \`claude\`, or install pi`,
        `so it is reachable from a global npm/bun root. Original error: ${
          (err && err.message).split("\n")[0]
        })`,
      ].join("\n"),
    );
  }
  throw err;
}

export const runClaudeShim = entryMod.runClaudeShim;
