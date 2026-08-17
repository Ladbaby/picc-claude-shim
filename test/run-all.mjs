#!/usr/bin/env node
/**
 * Run all pi-claude-shim unit tests. Used as a one-shot smoke check.
 *
 *   node test/run-all.mjs
 */

import { createJiti } from "jiti";
import process from "node:process";

const tests = [
  "args.test.ts",
  "tool-names.test.ts",
  "session-jsonl.test.ts",
  "cost.test.ts",
  "translator.test.ts",
  "translator-out.test.ts",
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
