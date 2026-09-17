#!/usr/bin/env node
/**
 * Run all pi-claude-shim unit tests. Used as a one-shot smoke check.
 *
 *   node test/run-all.mjs
 *
 * Note: `entry.e2e.test.ts` is intentionally NOT in this list — it spawns
 * the real shim and needs a live pi model + API key. Run it separately via
 * `node test/run-e2e.mjs`.
 */

import { createJiti } from "jiti";
import process from "node:process";

const tests = [
  "args.test.ts",
  "tool-names.test.ts",
  "session-jsonl.test.ts",
  "cost.test.ts",
  "permission-gate.test.ts",
  "translator.test.ts",
  "translator-out.test.ts",
  "structured-output.test.ts",
  "session-resume.test.ts",
  "compact.test.ts",
  "skills.test.ts",
];

const jiti = createJiti(import.meta.url, { interopDefault: true });

for (const t of tests) {
  process.stdout.write(`--- ${t} ---\n`);
  // Each test sets process.exitCode on failure; we accumulate via
  // a synchronous require call because the tests are top-level
  // expressions.
  const mod = await jiti.import(`./${t}`);
  void mod;
}

process.on("exit", (code) => {
  process.stdout.write(code === 0 ? "ALL OK\n" : `FAIL exit=${code}\n`);
});
