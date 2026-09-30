#!/usr/bin/env node

import { runInstaller } from "./installer-lib.mjs";

try {
  process.exitCode = (await runInstaller()) ? 0 : 1;
} catch (error) {
  process.stderr.write(
    `[picc-claude-shim/install] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
