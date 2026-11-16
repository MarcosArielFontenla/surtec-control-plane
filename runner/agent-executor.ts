import { types as utilTypes } from "node:util";

export type RunMode = "read-only" | "workspace-write" | "workspace-write-verify";

export interface AgentUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

const usageFields = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const;

/** Normalize evidence only; a valid numeric sample does not prove final usage. */
export function isCompleteAgentUsage(value: unknown): value is AgentUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== usageFields.length || keys.some((key) => typeof key !== "string" || !usageFields.includes(key as typeof usageFields[number]))) return false;
  return usageFields.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor?.enumerable && "value" in descriptor && Number.isSafeInteger(descriptor.value) && descriptor.value >= 0;
  });
}

export type AgentEvent =
  | { type: "thread-started"; at: string; threadId: string }
  | { type: "turn-started"; at: string; threadId: string; turnId: string }
  | { type: "message-delta"; at: string; threadId: string; turnId: string; delta: string }
  | { type: "item"; at: string; threadId: string; turnId: string; phase: "started" | "completed"; itemId: string; itemType: string; status?: string }
  | { type: "approval"; at: string; threadId: string; turnId: string; approval: "command" | "file-change" | "unsupported"; allowed: boolean; command?: string }
  | { type: "usage"; at: string; threadId: string; turnId: string; usage: AgentUsage }
  | { type: "usage-unknown"; at: string; threadId: string; turnId: string; reason: "invalid-usage" | "final-usage-unproven" }
  | { type: "warning"; at: string; threadId?: string; turnId?: string; message: string }
  | { type: "turn-completed"; at: string; threadId: string; turnId: string; status: string };

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;

export interface AgentRunInput {
  cwd: string;
  developerInstructions: string;
  prompt: string;
  mode: RunMode;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  threadId?: string;
  /** Internal context contract; never forwarded as an experimental protocol field. */
  contextFingerprint?: string;
  /** Code-owned execution profile; never a public config map or grant. */
  runtimeContextProfile?: import("./runtime-context-profile").RuntimeContextProfileId;
  /** Trusted runner identity; never protocol input or model-owned authority. */
  executionIdentity?: import("./terminal-usage-evidence").ExecutionIdentity;
  resumeContextFingerprint?: string;
  verifyCommands?: string[];
  outputSchema: Record<string, unknown>;
}

export interface AgentRunResult {
  finalText: string;
  structuredOutput: unknown;
  threadId: string;
  turnId: string;
  usage: AgentUsage | null;
  /** Operational reported completeness, not provider billing finality. Omitted by historical fakes. */
  usageComplete?: boolean;
  terminalUsageEvidence?: import("./terminal-usage-evidence").TerminalUsageEvidence;
  /** Monotonic proven observations, independent of final-total completeness. */
  usageHighWater?: AgentUsage | null;
}

export interface AgentExecutor {
  run(input: AgentRunInput, events: AgentEventSink, signal: AbortSignal): Promise<AgentRunResult>;
}
import type { ReasoningEffort } from "./generated/codex-app-server/ReasoningEffort";

