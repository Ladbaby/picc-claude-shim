/**
 * Single source of truth for the version string the shim reports to the
 * outside world.
 *
 * Plain ESM JavaScript (not TypeScript) so that BOTH:
 *   - `bin/claude.js` (the plain-JS fast path for `--version`/`--help`), and
 *   - the jiti-transpiled TS sources (`entry.ts`, `session-jsonl.ts`, ...)
 * can import it without pulling in the pi runtime.
 */

/** The raw semver the shim impersonates as a Claude Code release. */
export const CLAUDE_CODE_VERSION = "1.0.37";

/** Exactly what `claude --version` prints (matches Claude Code's format). */
export const CLAUDE_CODE_VERSION_LINE = `${CLAUDE_CODE_VERSION} (Claude Code)`;

/**
 * The `claude_code_version` field used inside `system/init` and the session
 * JSONL `version` field. Claude Code uses the bare semver here (no
 * "(Claude Code)" suffix).
 */
export const CLAUDE_CODE_VERSION_BARE = CLAUDE_CODE_VERSION;
