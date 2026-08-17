/**
 * pi-claude-shim extension entry.
 *
 * This file is a small marker extension that pi auto-loads when the
 * extension is in `settings.json#packages` (or available via
 * `pi install`). It registers a CLI flag handler for ergonomic
 * in-pi invocation:
 *
 *     pi --claude-shim-args=... --output-format stream-json ...
 *
 * The actual drop-in binary lives in `bin/claude.{js,cmd}` and runs
 * `runClaudeShim(argv)` directly. This file exists to make the
 * extension discoverable to pi's package system.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function extension(pi: ExtensionAPI): void {
  // No-op: the shim is a Node.js binary called independently of pi.
  // We still register a flag so users can verify install from inside
  // a pi session: `pi --claude-shim-install` writes the entry shim.
  pi.registerFlag("claude-shim-install", {
    description:
      "Generate bin/claude.cmd in the user's PATH (or print the install command).",
    type: "boolean",
  });
}
