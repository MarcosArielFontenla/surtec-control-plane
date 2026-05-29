import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, Options, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export type RunMode = "read-only" | "workspace-write";

export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;
export const WRITE_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "MultiEdit"] as const;

// Shell/exec + notebook edits are NEVER allowed, in either mode.
const EXEC_TOOLS = ["Bash", "BashOutput", "KillBash", "NotebookEdit"];
// = WRITE_TOOLS - READ_ONLY_TOOLS. If WRITE_TOOLS gains a tool, add it here too.
const WRITE_TOOLS_DISALLOWED_IN_READONLY = ["Write", "Edit", "MultiEdit"];

export interface RunOptions {
  cwd: string;
  systemPrompt: string;
  prompt: string;
  mode: RunMode;
  model?: string;
  maxTurns?: number;
}

export interface RunResult {
  text: string;
  costUsd: number;
  tokens: number;
}

type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

// Pure mode-aware policy. Tested without the SDK.
export function buildQueryOptions(o: RunOptions): {
  cwd: string;
  systemPrompt: string;
  model: string;
  maxTurns: number;
  allowedTools: string[];
  disallowedTools: string[];
  canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;
} {
  const allowed = (o.mode === "workspace-write" ? WRITE_TOOLS : READ_ONLY_TOOLS) as readonly string[];
  const disallowed =
    o.mode === "workspace-write" ? [...EXEC_TOOLS] : [...EXEC_TOOLS, ...WRITE_TOOLS_DISALLOWED_IN_READONLY];
  return {
    cwd: o.cwd,
    systemPrompt: o.systemPrompt,
    model: o.model ?? "claude-sonnet-4-6",
    maxTurns: o.maxTurns ?? 12,
    allowedTools: [...allowed],
    disallowedTools: disallowed,
    canUseTool: async (toolName, input) =>
      allowed.includes(toolName)
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: `runner (${o.mode}): tool '${toolName}' is not permitted` },
  };
}

export async function runAgent(o: RunOptions, signal?: AbortSignal): Promise<RunResult> {
  const controller = new AbortController();
  if (signal?.aborted) {
    controller.abort();
  } else if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const policyOpts = buildQueryOptions(o);
  const canUseToolSdk: CanUseTool = async (toolName, input, _sdkOptions) =>
    policyOpts.canUseTool(toolName, input) as ReturnType<CanUseTool>;

  const sdkOptions: Options = {
    cwd: policyOpts.cwd,
    systemPrompt: policyOpts.systemPrompt,
    model: policyOpts.model,
    maxTurns: policyOpts.maxTurns,
    allowedTools: policyOpts.allowedTools,
    disallowedTools: policyOpts.disallowedTools,
    canUseTool: canUseToolSdk,
    abortController: controller,
  };

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
  const errors: string[] = resultMessage.errors ?? [];
  throw new Error(
    "agent run failed: " + resultMessage.subtype + (errors.length > 0 ? ": " + errors.join("; ") : ""),
  );
}
