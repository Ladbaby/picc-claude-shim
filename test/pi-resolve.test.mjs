import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  candidatePiPkgDirs,
  looksLikePiPkgDir,
  managedPiPkgDir,
  resolvePiPkgDir,
} from "../bin/pi-resolve.mjs";
import { ensureLauncher, launcherDirectory } from "../installer-lib.mjs";

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
  const dir = mkdtempSync(join(tmpdir(), "picc-claude-shim-resolve-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Make a minimal dir that `looksLikePiPkgDir` accepts. */
function makeFakePiPkg(dir) {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.js"), "// fake pi\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-coding-agent" }), "utf8");
}

// An env that points every "ambient" source (home, bun, pi-agent roots) at
// throwaway temp paths, so resolution depends only on what the test stages.
function hermeticEnv(baseDir, extra = {}) {
  return {
    PI_CODING_AGENT_DIR: join(baseDir, "agent"),
    BUN_INSTALL: join(baseDir, "bun"),
    HOME: baseDir,
    ...extra,
  };
}

await test("looksLikePiPkgDir validates a real install layout", async () => {
  await withTempDir(async (dir) => {
    const pkg = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    assert.equal(looksLikePiPkgDir(pkg), false);
    makeFakePiPkg(pkg);
    assert.equal(looksLikePiPkgDir(pkg), true);
    assert.equal(looksLikePiPkgDir(join(dir, "does-not-exist")), false);
    assert.equal(looksLikePiPkgDir(""), false);
  });
});

await test("resolvePiPkgDir prefers the PICC_CLAUDE_SHIM_PI_DIR override", async () => {
  await withTempDir(async (dir) => {
    const override = join(dir, "override-pi");
    makeFakePiPkg(override);
    const bunPi = join(dir, "bun", "install", "global", "node_modules", "@earendil-works", "pi-coding-agent");
    makeFakePiPkg(bunPi);

    const env = hermeticEnv(dir, { PICC_CLAUDE_SHIM_PI_DIR: override });
    // selfDir inside a temp tree with no local node_modules; no real pi present.
    const found = resolvePiPkgDir({ env, selfDir: dir });
    assert.equal(found, override);
  });
});

await test("resolvePiPkgDir finds a pi install in a global bun root", async () => {
  await withTempDir(async (dir) => {
    const bunPi = join(dir, "bun", "install", "global", "node_modules", "@earendil-works", "pi-coding-agent");
    makeFakePiPkg(bunPi);
    const found = resolvePiPkgDir({ env: hermeticEnv(dir), selfDir: dir });
    assert.equal(found, bunPi);
  });
});

await test("resolvePiPkgDir prefers a local node_modules install over a bun global", async () => {
  await withTempDir(async (dir) => {
    // A "dev checkout" subtree: selfDir contains its own node_modules pi.
    const selfDir = join(dir, "checkout", "src");
    mkdirSync(selfDir, { recursive: true });
    const localPi = join(dir, "checkout", "node_modules", "@earendil-works", "pi-coding-agent");
    makeFakePiPkg(localPi);
    // A bun global pi that would also be discoverable — local must win.
    const bunPi = join(dir, "bun", "install", "global", "node_modules", "@earendil-works", "pi-coding-agent");
    makeFakePiPkg(bunPi);

    const found = resolvePiPkgDir({ env: hermeticEnv(dir), selfDir });
    assert.equal(found, localPi);
  });
});

await test("resolvePiPkgDir finds pi's active managed release", async () => {
  await withTempDir(async (dir) => {
    const agentDir = join(dir, "agent");
    const version = "0.99.1";
    const managedPi = join(
      agentDir,
      "install",
      "releases",
      version,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    mkdirSync(join(agentDir, "install"), { recursive: true });
    writeFileSync(join(agentDir, "install", "current-version"), `${version}\n`, "utf8");
    makeFakePiPkg(managedPi);

    assert.equal(managedPiPkgDir(agentDir), managedPi);
    assert.equal(
      resolvePiPkgDir({
        env: hermeticEnv(dir),
        selfDir: dir,
        includeNpmGlobal: false,
      }),
      managedPi,
    );
  });
});

await test("managedPiPkgDir ignores unsafe release identifiers", async () => {
  await withTempDir(async (dir) => {
    const agentDir = join(dir, "agent");
    mkdirSync(join(agentDir, "install"), { recursive: true });
    writeFileSync(join(agentDir, "install", "current-version"), "../../unexpected\n", "utf8");
    assert.equal(managedPiPkgDir(agentDir), null);
  });
});

await test("candidatePiPkgDirs honors a provided npm global root without shelling out", async () => {
  await withTempDir(async (dir) => {
    const npmRoot = join(dir, "npm-global");
    const dirs = candidatePiPkgDirs({
      env: hermeticEnv(dir),
      selfDir: dir,
      npmGlobalRoot: npmRoot,
    });
    assert.ok(dirs.includes(join(npmRoot, "@earendil-works/pi-coding-agent")));
    assert.ok(dirs.some((d) => d.includes(join(dir, "agent", "npm", "node_modules"))));
  });
});

await test("ensureLauncher materializes the deterministic POSIX launcher directory", async () => {
  await withTempDir(async (dir) => {
    const agentDir = join(dir, "agent");
    // Simulate the case where postinstall never ran: no extensions dir yet.
    assert.equal(existsSync(join(agentDir, "extensions", "picc-claude-shim", "bin")), false);

    const ok = ensureLauncher({ shimRoot: SHIM_ROOT, agentDir, platform: "linux" });
    assert.equal(ok, true);
    const launcher = join(launcherDirectory(agentDir), "claude");
    assert.equal(existsSync(launcher), true);
    assert.match(readFileSync(launcher, "utf8"), /exec node/);
  });
});

await test("ensureLauncher is a no-op for a self-referential source checkout", async () => {
  await withTempDir(async (dir) => {
    // agentDir == SHIM_ROOT means the extension dir IS the package root (junction case).
    const ok = ensureLauncher({ shimRoot: SHIM_ROOT, agentDir: SHIM_ROOT, platform: "linux" });
    assert.equal(ok, true);
  });
});
