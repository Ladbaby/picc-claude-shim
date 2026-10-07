import { randomUUID } from "node:crypto";
import type { PendingPermission, TranslatorState } from "./translator.js";

export type HostDecision = Parameters<PendingPermission["resolve"]>[0];

/** No deadline: settle only on a host response or explicit cancellation. */
export function requestHostTool(
  state: TranslatorState,
  pending: Map<string, PendingPermission>,
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<HostDecision> {
  return new Promise((resolve) => {
    const requestId = `perm_${randomUUID().slice(0, 24)}`;
    let settled = false;
    const finish = (decision: HostDecision) => {
      if (settled) return;
      settled = true;
      pending.delete(requestId);
      signal?.removeEventListener("abort", abort);
      resolve(decision);
    };
    const abort = () => {
      if (settled) return;
      finish({ behavior: "deny", message: "cancelled by client" });
      state.emitter.emit({ type: "control_cancel_request", request_id: requestId });
    };
    if (signal?.aborted) {
      finish({ behavior: "deny", message: "cancelled by client" });
      return;
    }
    // Register before emitting: even a synchronous response must find its entry.
    pending.set(requestId, { requestId, toolName, toolCallId, input, resolve: finish });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      state.emitter.emit({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "can_use_tool", tool_name: toolName, tool_use_id: toolCallId, input },
      });
    } catch (error) {
      finish({ behavior: "deny", message: String(error) });
    }
  });
}
