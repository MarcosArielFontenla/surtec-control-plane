import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, Options, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

export interface RunOptions {
  cwd: string;
  systemPrompt: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
}

export interface RunResult {
  text: string;
  costUsd: number;
  tokens: number;
}

// Fix 3: Tighten PermissionResult so the deny branch always carries a string
// message, matching the SDK's own PermissionResult discriminated union.
type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

// Pure read-only policy. Tested without the SDK.
export function buildQueryOptions(o: RunOptions): {
  cwd: string;
  systemPrompt: string;
  model: string;
  maxTurns: number;
  allowedTools: string[];
  canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;
} {
  const readOnly = READ_ONLY_TOOLS as readonly string[];
  return {
    cwd: o.cwd,
    systemPrompt: o.systemPrompt,
    model: o.model ?? "claude-sonnet-4-6",
    maxTurns: o.maxTurns ?? 12,
    allowedTools: [...READ_ONLY_TOOLS],
    canUseTool: async (toolName, input) =>
      readOnly.includes(toolName)
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: `read-only runner: tool '${toolName}' is not permitted` },
  };
}

// Write/exec tools disallowed at the SDK level for defense-in-depth (Fix 4).
// canUseTool already guarantees safety; this removes them from the model's context.
const DISALLOWED_TOOLS = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "BashOutput",
  "KillBash",
] as const;

export async function runReadOnlyAgent(o: RunOptions, signal?: AbortSignal): Promise<RunResult> {
  const controller = new AbortController();

  // Fix 1: handle signals that are already aborted before we register.
  if (signal?.aborted) {
    controller.abort();
  } else if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const policyOpts = buildQueryOptions(o);

  // Adapt the pure 2-arg canUseTool to the SDK's 3-arg CanUseTool signature.
  const canUseToolSdk: CanUseTool = async (toolName, input, _sdkOptions) =>
    policyOpts.canUseTool(toolName, input) as ReturnType<CanUseTool>;

  const sdkOptions: Options = {
    cwd: policyOpts.cwd,
    systemPrompt: policyOpts.systemPrompt,
    model: policyOpts.model,
    maxTurns: policyOpts.maxTurns,
    allowedTools: policyOpts.allowedTools,
    // Fix 4: belt-and-suspenders — remove write/exec tools from the model's context.
    disallowedTools: [...DISALLOWED_TOOLS],
    canUseTool: canUseToolSdk,
    abortController: controller,
  };

  // Fix 2: capture the terminal result message and distinguish success vs error.
  let resultMessage: SDKResultMessage | undefined;

  for await (const message of query({ prompt: o.prompt, options: sdkOptions }) as AsyncIterable<SDKMessage>) {
    if ((message as { type: string }).type === "result") {
      resultMessage = message as SDKResultMessage;
    }
  }

  if (!resultMessage) {
    throw new Error("agent produced no result message");
  }

  if (resultMessage.subtype === "success") {
    return {
      text: resultMessage.result ?? "",
      costUsd: resultMessage.total_cost_usd ?? 0,
      tokens: resultMessage.usage?.output_tokens ?? 0,
    };
  }

  // Error subtypes: error_during_execution, error_max_turns, error_max_budget_usd,
  // error_max_structured_output_retries — all have an errors: string[] field.
  const errors: string[] = resultMessage.errors ?? [];
  throw new Error(
    "agent run failed: " +
      resultMessage.subtype +
      (errors.length > 0 ? ": " + errors.join("; ") : ""),
  );
}
