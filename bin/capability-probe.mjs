import { createInterface } from "node:readline";

/**
 * Respond to T3 Code's no-prompt Claude Agent SDK capability probe without
 * loading pi or jiti. The full shim needs the pi runtime and can take longer
 * than T3's 25-second capability-probe deadline on slower Windows systems.
 *
 * T3 identifies this probe by using strict MCP configuration, workspace-only
 * setting sources, and disabled session persistence. Normal conversation
 * sessions retain persistence and remain on the full shim path.
 */
export function isCapabilityProbe(argv) {
  const valueAfter = (flag) => {
    const inline = argv.find((argument) => argument.startsWith(`${flag}=`));
    if (inline !== undefined) return inline.slice(flag.length + 1);
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };

  return (
    valueAfter("--output-format") === "stream-json" &&
    valueAfter("--input-format") === "stream-json" &&
    argv.includes("--strict-mcp-config") &&
    argv.includes("--no-session-persistence") &&
    valueAfter("--setting-sources") === "user,project,local"
  );
}

function initializeResponse() {
  return {
    commands: [],
    agents: [],
    output_style: "default",
    available_output_styles: ["default", "Explanatory", "Learning"],
    models: [
      {
        value: "claude-sonnet",
        displayName: "Claude Sonnet",
        description: "General-purpose coding model.",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "max"],
        supportsAdaptiveThinking: true,
        supportsFastMode: false,
        supportsAutoMode: false,
      },
    ],
    account: {
      email: null,
      organization: null,
      subscriptionType: "api",
      tokenSource: "apiKey",
      apiKeySource: "user",
      apiProvider: "firstParty",
    },
    pid: process.pid,
    fast_mode_state: "off",
  };
}

function usageResponse() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    session: {},
    subscription_type: "api",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 0, resets_at: nowSeconds + 5 * 3600 },
      seven_day: { utilization: 0, resets_at: nowSeconds + 7 * 24 * 3600 },
      model_scoped: [],
    },
    behaviors: null,
  };
}

function writeControlSuccess(requestId, response) {
  process.stdout.write(
    `${JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    })}\n`,
  );
}

/** Keep the lightweight process alive until the SDK aborts its no-prompt query. */
export function runCapabilityProbe() {
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message?.type !== "control_request" || typeof message.request_id !== "string") return;

    switch (message.request?.subtype) {
      case "initialize":
        writeControlSuccess(message.request_id, initializeResponse());
        break;
      case "get_usage":
      case "usage":
        writeControlSuccess(message.request_id, usageResponse());
        break;
      default:
        writeControlSuccess(message.request_id, {});
    }
  });
  input.on("close", () => process.exit(0));
}
