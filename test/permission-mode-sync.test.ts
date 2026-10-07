import assert from "node:assert/strict";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyHostMode, isPermissionMode, PermissionModeSync } from "../src/permission-mode-sync.js";

export async function run(): Promise<void> {
  const sync = new PermissionModeSync("bypassPermissions");
  await sync.setMode("plan");
  assert.equal(sync.mode, "plan");
  const applied: string[] = [];
  await sync.attach(async (mode) => { applied.push(mode); });
  assert.deepEqual(applied, ["bypassPermissions", "plan"], "lazy build replays the base and ordered staged transitions");
  await sync.setMode("bypassPermissions");
  assert.equal(sync.mode, "bypassPermissions");
  assert.deepEqual(applied, ["bypassPermissions", "plan", "bypassPermissions"]);

  let release!: () => void;
  const ordered = new PermissionModeSync("default");
  const slowApply = new Promise<void>((resolve) => { release = resolve; });
  const sequence: string[] = [];
  const attaching = ordered.attach(async (mode) => {
    sequence.push(mode);
    if (mode === "default") await slowApply;
  });
  const changeDuringBuild = ordered.setMode("plan");
  let acknowledged = false;
  void changeDuringBuild.then(() => { acknowledged = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(acknowledged, false);
  release();
  await attaching;
  await changeDuringBuild;
  assert.deepEqual(sequence, ["default", "plan"]);
  const restore = ordered.setMode("acceptEdits");
  const promptBarrier = ordered.barrier();
  await promptBarrier;
  assert.equal(ordered.mode, "acceptEdits", "prompt waits for preceding mode change");
  await restore;
  await assert.rejects(ordered.setMode("invalid"), /Unsupported/);
  assert.equal(ordered.mode, "acceptEdits");
  for (const value of [undefined, null, "dontAsk", "bypass", 1]) assert.equal(isPermissionMode(value), false);
  ordered.close();
  await assert.rejects(ordered.setMode("default"), /closed/);

  const events = createEventBus();
  const ctx = {} as ExtensionContext;
  await assert.rejects(applyHostMode(events, ctx, "plan", new AbortController().signal), /unavailable/);
  let reply!: (error?: string) => void;
  events.on("picc:permission-host:set-mode", (data) => {
    const request = data as { handled: boolean; respond: typeof reply };
    request.handled = true;
    reply = request.respond;
  });
  const controller = new AbortController();
  const waiting = applyHostMode(events, ctx, "plan", controller.signal);
  controller.abort();
  await assert.rejects(waiting, /cancelled/);
  reply(); // late success cannot change cancellation
  const failed = applyHostMode(events, ctx, "auto", new AbortController().signal);
  reply("extension rejected mode");
  await assert.rejects(failed, /extension rejected/);

  const failureSync = new PermissionModeSync("default");
  await failureSync.attach(async (mode) => { if (mode === "auto") throw new Error("failed to apply"); });
  await assert.rejects(failureSync.setMode("auto"), /failed to apply/);
  assert.equal(failureSync.mode, "default", "failed live application never reports the new mode");
  await assert.rejects(failureSync.barrier(), /failed to apply/);
  await failureSync.setMode("plan");
  assert.equal(failureSync.mode, "plan", "later valid control can recover");
  process.stdout.write("ok real host mode bridge, staging, ordered application, prompt barriers and cancellation\n");
}
