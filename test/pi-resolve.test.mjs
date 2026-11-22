import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildJitiAliases,
  candidatePiPkgDirs,
  looksLikePiPkgDir,
  managedPiPkgDir,
  resolvePiPkgDir,
  resolveTypeboxAliases,
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

// ---------------------------------------------------------------------------
// typebox aliasing
//
// `src/ask-user-question.ts` has a *value* import from `typebox`. Inside pi the
// extension loader maps that bare specifier to pi's own copy; in a standalone
// process nothing does. Without the aliases built by `buildJitiAliases`, the
// shim dies at module load with `Cannot find module 'typebox'` (BUG_REPORT.md).
// ---------------------------------------------------------------------------

/** Minimal package with `exports` subpaths, mirroring typebox's layout. */
function makeFakeSubpathPackage(dir, name, subpaths) {
  const targetFor = (sub) => (sub === "" ? "./build/index.mjs" : `./build/${sub}/index.mjs`);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      type: "module",
      exports: Object.fromEntries(
        subpaths.map((sub) => [sub === "" ? "." : `./${sub}`, { default: targetFor(sub) }]),
      ),
    }),
    "utf8",
  );
  for (const sub of subpaths) {
    const target = join(dir, targetFor(sub));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, `export const ${sub === "" ? "Type" : "x"} = {};\n`);
  }
}

await test("buildJitiAliases includes a typebox key when pi is present", async () => {
  await withTempDir(async (dir) => {
    const piDir = join(dir, "pi");
    makeFakePiPkg(piDir);
    // Simulate the typebox package that ships *inside* pi's install.
    const tbDir = join(piDir, "node_modules", "typebox");
    mkdirSync(tbDir, { recursive: true });
    makeFakeSubpathPackage(tbDir, "typebox", ["", "compile", "value"]);

    const aliases = buildJitiAliases(piDir);
    assert.equal(aliases["@earendil-works/pi-coding-agent"], piDir);
    assert.equal(existsSync(aliases.typebox), true);
    assert.equal(existsSync(aliases["typebox/compile"]), true);
    // Aliases point at real files, not at the package directory: typebox has
    // no `main`, so a directory alias fails deeper in the module graph.
    assert.match(aliases.typebox, /[\\/]build[\\/]index\.mjs$/);
    // Subpaths the installed version does not export are omitted, not faked.
    assert.equal(aliases["typebox/system"], undefined);
    // Legacy specifier mirrors the canonical one, as pi's loader does.
    assert.equal(aliases["@sinclair/typebox"], aliases.typebox);
    assert.equal(aliases["@sinclair/typebox/compile"], aliases["typebox/compile"]);
  });
});

await test("buildJitiAliases is empty without a pi install", async () => {
  assert.deepEqual(buildJitiAliases(null), {});
  assert.deepEqual(buildJitiAliases(""), {});
  assert.deepEqual(resolveTypeboxAliases({ piDir: null }), {});
});

await test("resolveTypeboxAliases resolves against the real pi install", async () => {
  const piDir = resolvePiPkgDir();
  if (!piDir) {
    // No pi install in this environment — nothing to assert against.
    process.stdout.write("skip (no pi install found)\n");
    return;
  }
  const aliases = resolveTypeboxAliases({ piDir });
  assert.ok(aliases.typebox, "typebox alias must resolve against pi's install");
  assert.ok(
    aliases.typebox.startsWith(piDir) || aliases.typebox.includes("typebox"),
    `unexpected typebox alias: ${aliases.typebox}`,
  );
});

await test("jiti loads ask-user-question.ts with the typebox aliases (standalone)", async () => {
  // Copy the module into a temp tree with no typebox anywhere up the chain, so
  // only the aliases can satisfy its `import { Type } from "typebox"`.
  const piDir = resolvePiPkgDir();
  if (!piDir) {
    process.stdout.write("skip (no pi install found)\n");
    return;
  }
  const { createJiti } = await import("jiti");
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, "src"), { recursive: true });
    copyFileSync(join(SHIM_ROOT, "src", "ask-user-question.ts"), join(dir, "src", "ask-user-question.ts"));

    const bare = createJiti(join(dir, "probe.mjs"), { interopDefault: true });
    assert.throws(
      () => bare(join(dir, "src", "ask-user-question.ts")),
      /Cannot find module 'typebox'|MODULE_NOT_FOUND/,
      "sanity check: without aliases the module fails to load",
    );

    const aliased = createJiti(join(dir, "probe.mjs"), {
      interopDefault: true,
      alias: buildJitiAliases(piDir),
    });
    const mod = aliased(join(dir, "src", "ask-user-question.ts"));
    assert.equal(typeof mod.createAskUserQuestionTool, "function");
  });
});

await test("standalone shim starts without MODULE_NOT_FOUND (no typebox in scope)", async () => {
  const piDir = resolvePiPkgDir();
  if (!piDir) {
    process.stdout.write("skip (no pi install found)\n");
    return;
  }
  await withTempDir(async (dir) => {
    // Install-shaped copy: only `jiti` present, so `typebox` is genuinely
    // unresolvable by walk-up — exactly the reported failure mode.
    const shimCopy = join(dir, "picc-claude-shim");
    mkdirSync(join(shimCopy, "node_modules"), { recursive: true });
    for (const entry of ["bin", "src", "package.json", "installer-lib.mjs", "claude-code-version.json"]) {
      cpSync(join(SHIM_ROOT, entry), join(shimCopy, entry), { recursive: true });
    }
    cpSync(join(SHIM_ROOT, "node_modules", "jiti"), join(shimCopy, "node_modules", "jiti"), {
      recursive: true,
    });

    const result = spawnSync(
      process.execPath,
      [join(shimCopy, "bin", "claude.js"), "--output-format", "stream-json", "--input-format", "stream-json"],
      {
        cwd: dir,
        input: "",
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          PICC_CLAUDE_SHIM_PI_DIR: piDir,
          PICC_CLAUDE_SHIM_DISABLE_SELF_INSTALL: "1",
          PI_CODING_AGENT_DIR: join(dir, "agent"),
        },
      },
    );

    assert.doesNotMatch(
      `${result.stderr}`,
      /Cannot find module 'typebox'|MODULE_NOT_FOUND/,
      `standalone start crashed: ${result.stderr}`,
    );
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /"type":"system","subtype":"init"/);
  });
});
