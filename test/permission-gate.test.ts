/**
 * Unit test for the permission-gate decision.
 *
 * The gate is open only when the parent asks for stdio permission prompts
 * AND the mode is not bypassPermissions.
 */

import { computeGateOpen } from "../src/entry.js";

function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    process.stderr.write(
      `FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`ok ${label}\n`);
}

// stdio requested + non-bypass mode -> gate open.
assertEq(computeGateOpen("stdio", "default"), true, "stdio + default -> open");
assertEq(computeGateOpen("stdio", "acceptEdits"), true, "stdio + acceptEdits -> open");
assertEq(computeGateOpen("stdio", "plan"), true, "stdio + plan -> open");

// stdio requested + bypass -> gate closed.
assertEq(computeGateOpen("stdio", "bypassPermissions"), false, "stdio + bypass -> closed");

// No stdio requested -> gate closed even for non-bypass mode.
assertEq(computeGateOpen(undefined, "default"), false, "no stdio + default -> closed");
assertEq(computeGateOpen(undefined, "acceptEdits"), false, "no stdio + acceptEdits -> closed");
assertEq(computeGateOpen(undefined, undefined), false, "no stdio + no mode -> closed");
