import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, Options, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export type RunMode = "read-only" | "workspace-write" | "workspace-write-verify";

export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;
export const WRITE_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "MultiEdit"] as const;
export const VERIFY_TOOLS = [...WRITE_TOOLS, "Bash", "BashOutput", "KillBash"] as const;

// Shell/exec tools are denied in read-only and workspace-write. In workspace-write-verify,
// Bash/BashOutput/KillBash are allowed but Bash is gated by canUseTool exact-match; NotebookEdit
// is denied in all modes.
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
  verifyCommands?: string[];
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
  const allowed = (
    o.mode === "workspace-write-verify"
      ? VERIFY_TOOLS
      : o.mode === "workspace-write"
        ? WRITE_TOOLS
        : READ_ONLY_TOOLS
  ) as readonly string[];
  const disallowed =
    o.mode === "read-only"
      ? [...EXEC_TOOLS, ...WRITE_TOOLS_DISALLOWED_IN_READONLY]
      : o.mode === "workspace-write"
        ? [...EXEC_TOOLS]
        : ["NotebookEdit"]; // workspace-write-verify: Bash/BashOutput/KillBash allowed; NotebookEdit denied
  const verifySet = new Set(o.verifyCommands ?? []);
  return {
    cwd: o.cwd,
    systemPrompt: o.systemPrompt,
    model: o.model ?? "claude-sonnet-4-6",
    maxTurns: o.maxTurns ?? (o.mode === "workspace-write-verify" ? 20 : 12),
    allowedTools: [...allowed],
    disallowedTools: disallowed,
    canUseTool: async (toolName, input) => {
      if (o.mode === "workspace-write-verify" && toolName === "Bash") {
        const cmd = typeof input.command === "string" ? input.command.trim() : "";
        return cmd !== "" && verifySet.has(cmd)
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: `runner (verify): Bash command not allowlisted: ${cmd}` };
      }
      return allowed.includes(toolName)
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: `runner (${o.mode}): tool '${toolName}' is not permitted` };
    },
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
