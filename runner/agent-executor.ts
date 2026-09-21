export type RunMode = "read-only" | "workspace-write" | "workspace-write-verify";

export interface AgentUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export type AgentEvent =
  | { type: "thread-started"; at: string; threadId: string }
  | { type: "turn-started"; at: string; threadId: string; turnId: string }
  | { type: "message-delta"; at: string; threadId: string; turnId: string; delta: string }
  | { type: "item"; at: string; threadId: string; turnId: string; phase: "started" | "completed"; itemId: string; itemType: string; status?: string }
  | { type: "approval"; at: string; threadId: string; turnId: string; approval: "command" | "file-change" | "unsupported"; allowed: boolean; command?: string }
  | { type: "usage"; at: string; threadId: string; turnId: string; usage: AgentUsage }
  | { type: "warning"; at: string; threadId?: string; turnId?: string; message: string }
  | { type: "turn-completed"; at: string; threadId: string; turnId: string; status: string };

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;

export interface AgentRunInput {
  cwd: string;
  developerInstructions: string;
  prompt: string;
  mode: RunMode;
  model?: string;
  reasoningEffort?: string;
  threadId?: string;
  verifyCommands?: string[];
  outputSchema: Record<string, unknown>;
}

export interface AgentRunResult {
  finalText: string;
  structuredOutput: unknown;
  threadId: string;
  turnId: string;
  usage: AgentUsage | null;
}

export interface AgentExecutor {
  run(input: AgentRunInput, events: AgentEventSink, signal: AbortSignal): Promise<AgentRunResult>;
}

