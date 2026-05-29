import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

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

interface PermissionResult {
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  message?: string;
}

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

export async function runReadOnlyAgent(o: RunOptions, signal?: AbortSignal): Promise<RunResult> {
  const controller = new AbortController();
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

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
    canUseTool: canUseToolSdk,
    abortController: controller,
  };

  let text = "";
  let costUsd = 0;
  let tokens = 0;

  for await (const message of query({ prompt: o.prompt, options: sdkOptions }) as AsyncIterable<SDKMessage>) {
    const m = message as {
      type: string;
      subtype?: string;
      result?: string;
      total_cost_usd?: number;
      usage?: { output_tokens?: number };
    };
    if (m.type === "result") {
      text = m.result ?? "";
      costUsd = m.total_cost_usd ?? 0;
      tokens = m.usage?.output_tokens ?? 0;
    }
  }

  return { text, costUsd, tokens };
}
