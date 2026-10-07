import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ClaudePermissionMode } from "./args.js";

const HOST_MODE_REQUEST = "picc:permission-host:set-mode";
export function isPermissionMode(value: unknown): value is ClaudePermissionMode {
  return typeof value === "string" && ["default", "acceptEdits", "plan", "bypassPermissions", "auto"].includes(value);
}

/** Apply to the real extension; an absent capability must never report success. */
export function applyHostMode(
  events: ExtensionAPI["events"], ctx: ExtensionContext, mode: ClaudePermissionMode, signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const respond = (error?: string) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(new Error(error));
      else resolve();
    };
    const abort = () => respond("cancelled by client");
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    const request = { mode, ctx, signal, handled: false, respond };
    try {
      events.emit(HOST_MODE_REQUEST, request);
      if (!request.handled) respond("Permission-mode host bridge is unavailable.");
    } catch (error) {
      respond(String(error));
    }
  });
}

type ApplyMode = (mode: ClaudePermissionMode) => Promise<void>;

/** Only mode transitions are serialized, never model turns or host answers. */
export class PermissionModeSync {
  private tail: Promise<void> = Promise.resolve();
  private staged: ClaudePermissionMode[];
  private apply: ApplyMode | undefined;
  private closed = false;
  mode: ClaudePermissionMode;

  constructor(initialMode: ClaudePermissionMode) {
    this.mode = initialMode;
    this.staged = [initialMode];
  }

  barrier(): Promise<void> { return this.tail; }

  setMode(value: unknown): Promise<void> {
    if (!isPermissionMode(value)) return Promise.reject(new Error(`Unsupported permission mode: ${String(value)}`));
    return this.enqueue(async () => {
      if (this.apply) await this.apply(value);
      else this.staged.push(value);
      this.mode = value;
    });
  }

  /** Called only after a real user turn builds the session, never by a probe. */
  attach(apply: ApplyMode): Promise<void> {
    return this.enqueue(async () => {
      for (const mode of this.staged) await apply(mode);
      this.staged = [];
      this.apply = apply;
    });
  }

  close(): void { this.closed = true; }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.tail.catch(() => {}).then(async () => {
      if (this.closed) throw new Error("Permission-mode session is closed.");
      await operation();
    });
    this.tail = next;
    // A rejected barrier remains observable to prompts, without an unhandled rejection.
    void next.catch(() => {});
    return next;
  }
}
