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
import { isCapabilityProbe } from "../bin/capability-probe.mjs";
import {
  FALLBACK_CLAUDE_CODE_VERSION,
  getClaudeCodeVersion,
  readCachedClaudeCodeVersion,
  refreshClaudeCodeVersion,
  writeCachedClaudeCodeVersion,
} from "../src/version.js";

const SHIM_ROOT = fileURLToPath(new URL("..", import.meta.url));

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`ok ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "picc-claude-shim-install-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await test("detects only pi npm-managed installs", () => {
  assert.equal(isPiManagedInstall(`C:/x/npm/node_modules/${PACKAGE_NAME}`), true);
  assert.equal(isPiManagedInstall("C:/x/extensions/picc-claude-shim"), false);
});

await test("uses a stable launcher directory beneath the pi agent directory", () => {
  assert.equal(
    launcherDirectory("C:/Users/Test/.pi/agent"),
    join("C:/Users/Test/.pi/agent", "extensions", EXTENSION_NAME, "bin"),
  );
});

await test("identifies T3's no-prompt capability probe without matching normal sessions", () => {
  assert.equal(
    isCapabilityProbe([
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--setting-sources=user,project,local",
      "--strict-mcp-config",
      "--no-session-persistence",
    ]),
    true,
  );
  assert.equal(isCapabilityProbe(["--output-format", "stream-json"]), false);
});

await test("fetches and persists the release version only during installation", async () => {
  await withTempDir(async (dir) => {
    const fetchCalls = [];
    const version = await refreshClaudeCodeVersion({
      cacheDir: dir,
      fetchImpl: async (url) => {
        fetchCalls.push(url);
        return { ok: true, json: async () => ({ tag_name: "v1.2.3" }) };
      },
    });
    assert.equal(version, "1.2.3");
    assert.deepEqual(fetchCalls, ["https://api.github.com/repos/anthropics/claude-code/releases/latest"]);
    assert.equal(readCachedClaudeCodeVersion(dir), "1.2.3");
    assert.equal(getClaudeCodeVersion(dir), "1.2.3");
  });
});

await test("uses the bundled version when no release cache exists", async () => {
  await withTempDir(async (dir) => {
    assert.equal(getClaudeCodeVersion(dir), FALLBACK_CLAUDE_CODE_VERSION);
    assert.throws(() => writeCachedClaudeCodeVersion("not-a-version", dir));
  });
});

await test("installs Windows launcher and release cache without PATH", async () => {
  await withTempDir(async (dir) => {
    const agentDir = join(dir, "agent");
    const logs = [];

    assert.equal(await runInstaller({
      shimRoot: SHIM_ROOT,
      agentDir,
      platform: "win32",
      fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: "v9.9.9" }) }),
      log: (...parts) => logs.push(parts.join(" ")),
    }), true);

    const extensionDir = join(agentDir, "extensions", EXTENSION_NAME);
    const targetDir = launcherDirectory(agentDir);
    assert.equal(existsSync(join(targetDir, "claude.exe")), true);
    assert.equal(readFileSync(join(targetDir, SHIM_ROOT_FILE), "utf8"), `${resolve(SHIM_ROOT)}\n`);
    assert.equal(readCachedClaudeCodeVersion(extensionDir), "9.9.9");
    assert.match(logs.join("\n"), /Windows launcher installed/);
    assert.match(logs.join("\n"), /no PATH changes were made/);
  });
});

await test("runs a copied Windows launcher through its root sidecar", async () => {
  if (process.platform !== "win32") return;
  await withTempDir(async (dir) => {
    const launcher = join(dir, "claude.exe");
    copyFileSync(join(SHIM_ROOT, "bin", "claude.exe"), launcher);
    writeFileSync(join(dir, SHIM_ROOT_FILE), `${resolve(SHIM_ROOT)}\n`, "utf8");
    // Point the launcher at an isolated, empty cache dir so it deterministically
    // reports the bundled fallback, independent of any live release cache on disk.
    assert.equal(
      execFileSync(launcher, ["--version"], {
        encoding: "utf8",
        env: { ...process.env, PI_CODING_AGENT_DIR: dir },
      }).trim(),
      "1.0.37 (Claude Code)",
    );
  });
});

await test("installs a POSIX launcher without PATH", async () => {
  await withTempDir(async (dir) => {
    const agentDir = join(dir, "agent");

    assert.equal(await runInstaller({ shimRoot: SHIM_ROOT, agentDir, platform: "linux" }), true);
    const launcher = readFileSync(join(launcherDirectory(agentDir), "claude"), "utf8");
    assert.match(launcher, /exec node/);
    assert.match(launcher, /claude\.js/);
  });
});
