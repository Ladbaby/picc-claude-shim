#!/usr/bin/env node
/**
 * Build a native Windows `claude.exe` for picc-claude-shim.
 *
 * T3 Code's Claude Agent SDK spawns the Claude Code executable with NO shell
 * and no PATHEXT resolution; Node >= 20.12 refuses to spawn `.cmd`/`.bat`
 * files without a shell, so T3 needs a real `claude.exe`. This script builds
 * one from `scripts/claude_launcher.c` using a C compiler (gcc/mingw is the
 * normal case; cl.exe also works). The exe is a thin launcher that locates
 * this install and runs `node bin/claude.js <args>`, so `--version` is fast
 * and the pi-backed orchestrator runs under the normal Node runtime.
 *
 * Usage:
 *   node scripts/build-exe.mjs [outputPath]
 *
 * By default the exe is written to <shim>/bin/claude.exe. Because it lives in
 * bin/, the launcher finds the shim root from its own location at runtime, so
 * the whole install can be moved without rebuilding. Baked-in fallbacks
 * (shim root + node.exe) are embedded so it still works if moved elsewhere.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const SHIM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const C_SOURCE = join(SHIM_ROOT, "scripts", "claude_launcher.c");
const DEFAULT_OUT = join(SHIM_ROOT, "bin", "claude.exe");

function log(...a) {
  process.stderr.write("[picc-claude-shim:build-exe] " + a.join(" ") + "\n");
}

function findCompiler() {
  // Return { exe, args: [extra] } for a usable C compiler.
  const candidates = [
    { exe: "gcc", args: ["-municode"] },
    { exe: "cc", args: [] },
    { exe: "cl", args: [] },
  ];
  const explicit = process.env.PICC_CLAUDE_CC;
  if (explicit) return { exe: explicit, args: [] };
  for (const c of candidates) {
    const r = spawnSync(c.exe, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return null;
}

function shQuote(s) {
  // C macro string literal: escape backslashes and double quotes.
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function main() {
  const outPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUT;

  if (os.platform() !== "win32") {
    log(`note: building a native .exe is only meaningful on Windows (this is ${os.platform()}).`);
    log(`Proceeding anyway (a Windows target needs a mingw gcc).`);
  }

  const compiler = findCompiler();
  if (!compiler) {
    log("ERROR: no C compiler found (tried gcc, cc, cl).");
    log("Install mingw-w64 gcc (or set PICC_CLAUDE_CC=/path/to/gcc.exe) and re-run.");
    process.exit(1);
  }
  log(`using compiler: ${compiler.exe}`);

  const shimRootAbs = SHIM_ROOT.replace(/\\/g, "\\\\");
  const nodeExeAbs = process.execPath.replace(/\\/g, "\\\\");

  const defines = [
    `-DPICC_SHIM_ROOT=${shQuote(SHIM_ROOT)}`,
    `-DPICC_NODE_EXE=${shQuote(process.execPath)}`,
  ];

  const args = [];
  if (compiler.exe === "cl") {
    args.push(...defines, C_SOURCE, "/Fe" + outPath, "/link", "/SUBSYSTEM:CONSOLE");
  } else {
    args.push(
      C_SOURCE,
      "-o",
      outPath,
      "-O2",
      "-Wl,--subsystem,console",
      "-Wl,--kill-at",
      ...defines,
    );
  }

  log(`compiling: ${compiler.exe} ${args.join(" ")}`);
  const r = spawnSync(compiler.exe, args, { stdio: "inherit", cwd: SHIM_ROOT });
  if (r.status !== 0 || !existsSync(outPath)) {
    log("ERROR: compilation failed.");
    process.exit(r.status ?? 1);
  }
  try {
    chmodSync(outPath, 0o755);
  } catch {
    /* best-effort on Windows */
  }
  log(`built: ${outPath}`);
  log("smoke test:  " + outPath + " --version");
}

main();
