/**
 * Unit test for the permission-gate decision.
 *
 * The Claude Agent SDK drives permissions through an in-process `canUseTool`
 * callback, so the gate is open for any mode that is NOT `bypassPermissions`.
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

// Any non-bypass mode -> gate open (the SDK's canUseTool callback is invoked).
assertEq(computeGateOpen("stdio", "default"), true, "stdio + default -> open");
assertEq(computeGateOpen("stdio", "acceptEdits"), true, "stdio + acceptEdits -> open");
assertEq(computeGateOpen("stdio", "plan"), true, "stdio + plan -> open");
assertEq(computeGateOpen("stdio", "auto"), true, "stdio + auto -> open");
assertEq(computeGateOpen(undefined, "default"), true, "no stdio + default -> open");
assertEq(computeGateOpen(undefined, "acceptEdits"), true, "no stdio + acceptEdits -> open");
assertEq(computeGateOpen(undefined, undefined), true, "no stdio + no mode -> open");

// bypassPermissions -> gate closed (full-access; no permission round-trip).
assertEq(computeGateOpen("stdio", "bypassPermissions"), false, "stdio + bypass -> closed");
assertEq(computeGateOpen(undefined, "bypassPermissions"), false, "no stdio + bypass -> closed");
