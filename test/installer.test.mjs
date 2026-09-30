import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_NAME,
  WRAPPER_MARKER,
  isPiManagedInstall,
  pickBinDir,
  preflightWrapperTargets,
  runInstaller,
} from "../installer-lib.mjs";

const SHIM_ROOT = fileURLToPath(new URL("..", import.meta.url));

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "picc-claude-shim-install-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("detects only pi npm-managed installs", () => {
  assert.equal(isPiManagedInstall(`C:/x/npm/node_modules/${PACKAGE_NAME}`), true);
  assert.equal(isPiManagedInstall("C:/x/extensions/picc-claude-shim"), false);
});

test("chooses only a writable user bin directory already on PATH", () => {
  withTempDir((dir) => {
    const localBin = join(dir, ".local", "bin");
    assert.equal(pickBinDir({ homeDir: dir, pathValue: join(dir, "unrelated") }), null);
    assert.equal(pickBinDir({ homeDir: dir, pathValue: localBin }), localBin);
    assert.equal(existsSync(localBin), true);
  });
});

test("rejects non-picc wrapper collisions", () => {
  withTempDir((dir) => {
    const target = join(dir, "claude.cmd");
    writeFileSync(target, "@echo off\nREM Another Claude wrapper\n");
    const logs = [];
    assert.equal(
      preflightWrapperTargets({ cmd: target, posix: join(dir, "claude"), exe: join(dir, "claude.exe") }, {
        log: (...parts) => logs.push(parts.join(" ")),
      }),
      false,
    );
    assert.match(logs.join("\n"), /non-picc Claude wrapper/);
  });
});

test("accepts and updates picc-owned wrappers", () => {
  withTempDir((dir) => {
    const target = join(dir, "claude.cmd");
    writeFileSync(target, `@echo off\nREM ${WRAPPER_MARKER}\n`);
    assert.equal(
      preflightWrapperTargets({ cmd: target, posix: join(dir, "claude"), exe: join(dir, "claude.exe") }),
      true,
    );
  });
});

test("accepts legacy picc wrappers for an in-place upgrade", () => {
  withTempDir((dir) => {
    const target = join(dir, "claude.cmd");
    writeFileSync(target, "@echo off\nREM pi-claude-shim legacy wrapper\n");
    assert.equal(
      preflightWrapperTargets({ cmd: target, posix: join(dir, "claude"), exe: join(dir, "claude.exe") }),
      true,
    );
  });
});

test("writes marked wrappers and registers the correct local extension", () => {
  withTempDir((dir) => {
    const localBin = join(dir, ".local", "bin");
    const agentDir = join(dir, "agent");
    const settingsPath = join(agentDir, "settings.json");
    const logs = [];
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ packages: [] }));

    const result = runInstaller({
      args: ["--register-local"],
      shimRoot: SHIM_ROOT,
      agentDir,
      homeDir: dir,
      pathValue: localBin,
      platform: "linux",
      log: (...parts) => logs.push(parts.join(" ")),
    });

    assert.equal(result, true);
    assert.match(readFileSync(join(localBin, "claude.cmd"), "utf8"), new RegExp(WRAPPER_MARKER));
    assert.match(readFileSync(join(localBin, "claude"), "utf8"), new RegExp(WRAPPER_MARKER));
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).packages, ["extensions/picc-claude-shim"]);
    assert.match(logs.join("\n"), /installed claude\.cmd/);
  });
});

test("does not crash when settings packages is malformed", () => {
  withTempDir((dir) => {
    const localBin = join(dir, ".local", "bin");
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: "bad" }));
    const logs = [];

    assert.equal(runInstaller({
      args: ["--register-local"],
      shimRoot: SHIM_ROOT,
      agentDir,
      homeDir: dir,
      pathValue: localBin,
      platform: "linux",
      log: (...parts) => logs.push(parts.join(" ")),
    }), true);
    assert.match(logs.join("\n"), /packages is not an array/);
  });
});
