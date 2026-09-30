import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXTENSION_NAME,
  PACKAGE_NAME,
  SHIM_ROOT_FILE,
  isPiManagedInstall,
  launcherDirectory,
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

test("uses a stable launcher directory beneath the pi agent directory", () => {
  assert.equal(
    launcherDirectory("C:/Users/Test/.pi/agent"),
    join("C:/Users/Test/.pi/agent", "extensions", EXTENSION_NAME, "bin"),
  );
});

test("installs Windows launcher and package-root sidecar without PATH", () => {
  withTempDir((dir) => {
    const agentDir = join(dir, "agent");
    const logs = [];

    assert.equal(runInstaller({
      shimRoot: SHIM_ROOT,
      agentDir,
      platform: "win32",
      log: (...parts) => logs.push(parts.join(" ")),
    }), true);

    const targetDir = launcherDirectory(agentDir);
    assert.equal(existsSync(join(targetDir, "claude.exe")), true);
    assert.equal(readFileSync(join(targetDir, SHIM_ROOT_FILE), "utf8"), `${resolve(SHIM_ROOT)}\n`);
    assert.match(logs.join("\n"), /Windows launcher installed/);
    assert.match(logs.join("\n"), /no PATH changes were made/);
  });
});

test("runs a copied Windows launcher through its root sidecar", () => {
  if (process.platform !== "win32") return;
  withTempDir((dir) => {
    const launcher = join(dir, "claude.exe");
    copyFileSync(join(SHIM_ROOT, "bin", "claude.exe"), launcher);
    writeFileSync(join(dir, SHIM_ROOT_FILE), `${resolve(SHIM_ROOT)}\n`, "utf8");
    assert.equal(execFileSync(launcher, ["--version"], { encoding: "utf8" }).trim(), "1.0.37 (Claude Code)");
  });
});

test("installs a POSIX launcher without PATH", () => {
  withTempDir((dir) => {
    const agentDir = join(dir, "agent");

    assert.equal(runInstaller({ shimRoot: SHIM_ROOT, agentDir, platform: "linux" }), true);
    const launcher = readFileSync(join(launcherDirectory(agentDir), "claude"), "utf8");
    assert.match(launcher, /exec node/);
    assert.match(launcher, /claude\.js/);
  });
});
