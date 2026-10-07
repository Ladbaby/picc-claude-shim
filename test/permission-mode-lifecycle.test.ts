import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { applyHostMode, PermissionModeSync } from "../src/permission-mode-sync.js";

export async function run(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), "picc-mode-lifecycle-"));
  const oldConfig = process.env.PICC_PERMISSION_MODES_CONFIG_PATH;
  const oldMode = process.env.PICC_PERMISSION_MODE;
  process.env.PICC_PERMISSION_MODES_CONFIG_PATH = join(temp, "config.json");
  process.env.PICC_PERMISSION_MODE = "default";
  writeFileSync(process.env.PICC_PERMISSION_MODES_CONFIG_PATH, "{}");
  const events = createEventBus();
  const settings = SettingsManager.inMemory({});
  const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../picc-permission-modes/index.ts");
  const loader = new DefaultResourceLoader({ cwd: temp, agentDir: temp, settingsManager: settings,
    eventBus: events, additionalExtensionPaths: [extensionPath], noSkills: true, noThemes: true,
    noPromptTemplates: true, noContextFiles: true,
  });
  let dispose: (() => void) | undefined;
  try {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, [], "real extension loads successfully");
    const modelRuntime = await ModelRuntime.create({ authPath: join(temp, "auth.json"), modelsPath: join(temp, "models.json") });
    const { session } = await createAgentSession({ cwd: temp, agentDir: temp, settingsManager: settings,
      sessionManager: SessionManager.inMemory(temp), resourceLoader: loader, modelRuntime });
    dispose = () => session.dispose();
    const runner = session.extensionRunner!;
    const ctx = runner.createContext();
    events.on("picc:plan-host:capability", (data) => {
      const probe = data as { sessionId: string; available: boolean };
      if (probe.sessionId === session.sessionId) probe.available = true;
    });
    let captures = 0;
    events.on("picc:plan-host:request", (data) => {
      const request = data as { handled: boolean; input: { plan: string }; respond: (decision: { behavior: "deny"; message: string }) => void };
      request.handled = true;
      captures++;
      assert.equal(typeof request.input.plan, "string");
      request.respond({ behavior: "deny", message: "Plan captured. Wait for implementation turn." });
    });
    const sync = new PermissionModeSync("bypassPermissions");
    await sync.setMode("plan");
    const controller = new AbortController();
    await sync.attach((mode) => applyHostMode(events, ctx, mode, controller.signal));
    const call = (name: string) => runner.emitToolCall({ type: "tool_call", toolName: name, toolCallId: name, input: { file_path: join(temp, "project.txt"), content: "ok" } });
    // A real extension runner checks actual write permission; no model is called.
    const blocked = await call("write");
    assert.equal(blocked?.block, true, "plan mode blocks project writes");
    const exit = runner.getToolDefinition("ExitPlanMode")!;
    const result = await exit.execute("exit", {}, undefined, undefined, ctx);
    assert.match(JSON.stringify(result), /Plan captured/);
    assert.equal(captures, 1);
    assert.equal((await call("write"))?.block, true, "host denial leaves plan restrictions active");
    await sync.setMode("bypassPermissions");
    assert.equal(await call("write"), undefined, "later implementation control restores actual write access");
    // Child context cannot borrow a connected parent's capability.
    const childCtx = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => "child" } } as typeof ctx;
    for (const name of ["EnterPlanMode", "ExitPlanMode"]) {
      const definition = runner.getToolDefinition(name)!;
      const denied = await definition.execute("child", {}, undefined, undefined, childCtx);
      assert.match(JSON.stringify(denied), /subagents cannot use this tool/);
    }
    assert.equal(captures, 1, "children emit no host requests");
    process.stdout.write("ok real pi extension lifecycle: staged plan, denied exit, restored writes, rejected child tools\n");
  } finally {
    dispose?.();
    if (oldConfig === undefined) delete process.env.PICC_PERMISSION_MODES_CONFIG_PATH;
    else process.env.PICC_PERMISSION_MODES_CONFIG_PATH = oldConfig;
    if (oldMode === undefined) delete process.env.PICC_PERMISSION_MODE;
    else process.env.PICC_PERMISSION_MODE = oldMode;
    rmSync(temp, { recursive: true, force: true });
  }
}
