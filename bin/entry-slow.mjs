/**
 * Slow-path loader for the Claude shim.
 *
 * Loaded by `bin/claude.js` *only* after the `--version`/`--help` fast paths
 * have been ruled out. This is where we pull in the full pi runtime (via jiti
 * transpiling `../src/entry.ts`). Keeping the heavy import here — rather than
 * as a top-level static import in `claude.js` — is what makes `claude --version`
 * answer in milliseconds (T3 Code's probe allows only 4s).
 */

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const entryMod = jiti("../src/entry.ts");

export const runClaudeShim = entryMod.runClaudeShim;
