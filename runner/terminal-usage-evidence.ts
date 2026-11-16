import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { isCompleteAgentUsage, type AgentUsage } from "./agent-executor";

export interface ExecutionIdentity { taskId: string; executionId: string }
export type ProtocolUsage = AgentUsage & { cacheWriteInputTokens: number };
export interface TerminalUsageBinding extends ExecutionIdentity {
  contextFingerprint: string;
  threadId: string;
  turnId: string;
  usage: AgentUsage | null;
}
export interface TerminalUsageFacts extends TerminalUsageBinding {
  usage: AgentUsage;
  baseline: ProtocolUsage;
  protocolUsage: ProtocolUsage;
  finalItemId: string;
  finalPhase: "final_answer";
  finalItemSequence: number;
  usageSequence: number;
  terminalSequence: number;
  terminalStatus: "completed";
  exitCode: 0;
  signal: null;
  stdoutEof: true;
  stderrEof: true;
}
export interface TerminalUsageEvidence extends TerminalUsageFacts {
  version: 1;
  source: "codex-app-server-stdio";
  basis: "fresh-thread-cumulative-drained";
  digest: string;
}

const usageKeys = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const;
const protocolKeys = [...usageKeys, "cacheWriteInputTokens"] as const;
const factKeys = ["taskId", "executionId", "contextFingerprint", "threadId", "turnId", "usage", "baseline", "protocolUsage", "finalItemId", "finalPhase", "finalItemSequence", "usageSequence", "terminalSequence", "terminalStatus", "exitCode", "signal", "stdoutEof", "stderrEof"] as const;
const receiptKeys = ["version", "source", "basis", ...factKeys, "digest"] as const;

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === "string" && keys.includes(key))
    && keys.every((key) => { const d = Object.getOwnPropertyDescriptor(value, key); return !!d?.enumerable && "value" in d; });
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value);
}
function normalized(value: ProtocolUsage): AgentUsage {
  return Object.freeze({ inputTokens: value.inputTokens, cachedInputTokens: value.cachedInputTokens,
    outputTokens: value.outputTokens, reasoningOutputTokens: value.reasoningOutputTokens, totalTokens: value.totalTokens });
}
function protocol(value: unknown): value is ProtocolUsage {
  return closed(value, protocolKeys) && protocolKeys.every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0);
}
function facts(value: unknown): value is TerminalUsageFacts {
  if (!closed(value, factKeys)) return false;
  if (![value.taskId, value.executionId, value.threadId, value.turnId, value.finalItemId].every(identifier)
    || typeof value.contextFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.contextFingerprint)
    || !protocol(value.baseline) || !protocol(value.protocolUsage) || !isCompleteAgentUsage(value.usage)) return false;
  if (protocolKeys.some((key) => (value.baseline as ProtocolUsage)[key] !== 0)
    || usageKeys.some((key) => (value.protocolUsage as ProtocolUsage)[key] !== (value.usage as AgentUsage)[key])) return false;
  return [value.finalItemSequence, value.usageSequence, value.terminalSequence].every((n) => Number.isSafeInteger(n) && (n as number) > 0)
    && (value.finalItemSequence as number) < (value.usageSequence as number)
    && (value.usageSequence as number) < (value.terminalSequence as number)
    && value.finalPhase === "final_answer" && value.terminalStatus === "completed" && value.exitCode === 0
    && value.signal === null && value.stdoutEof === true && value.stderrEof === true;
}
function payload(value: TerminalUsageFacts) {
  return Object.freeze({ version: 1 as const, source: "codex-app-server-stdio" as const, basis: "fresh-thread-cumulative-drained" as const,
    taskId: value.taskId, executionId: value.executionId, contextFingerprint: value.contextFingerprint,
    threadId: value.threadId, turnId: value.turnId,
    usage: normalized(value.protocolUsage),
    baseline: Object.freeze({ ...normalized(value.baseline), cacheWriteInputTokens: value.baseline.cacheWriteInputTokens }),
    protocolUsage: Object.freeze({ ...normalized(value.protocolUsage), cacheWriteInputTokens: value.protocolUsage.cacheWriteInputTokens }),
    finalItemId: value.finalItemId, finalPhase: value.finalPhase, finalItemSequence: value.finalItemSequence,
    usageSequence: value.usageSequence, terminalSequence: value.terminalSequence, terminalStatus: value.terminalStatus,
    exitCode: value.exitCode, signal: value.signal, stdoutEof: value.stdoutEof, stderrEof: value.stderrEof });
}
function digest(value: ReturnType<typeof payload>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Trusted adapter construction, never a grant or proof of provider billing finality. */
export function createTerminalUsageEvidence(value: TerminalUsageFacts): TerminalUsageEvidence {
  if (!facts(value)) throw new Error("Invalid terminal usage facts");
  const body = payload(value);
  return Object.freeze({ ...body, digest: digest(body) });
}

/** Validate and detach untrusted JSON; this hash is a binding check, not a signature. */
export function validateTerminalUsageEvidence(value: unknown, binding: TerminalUsageBinding): TerminalUsageEvidence | null {
  if (!closed(value, receiptKeys) || value.version !== 1 || value.source !== "codex-app-server-stdio"
    || value.basis !== "fresh-thread-cumulative-drained" || typeof value.digest !== "string") return null;
  const rawFacts = Object.fromEntries(factKeys.map((key) => [key, value[key]]));
  if (!facts(rawFacts) || !isCompleteAgentUsage(binding.usage)) return null;
  const body = payload(rawFacts);
  if (value.digest !== digest(body) || ["taskId", "executionId", "contextFingerprint", "threadId", "turnId"].some((key) => body[key as keyof typeof body] !== binding[key as keyof TerminalUsageBinding])
    || usageKeys.some((key) => body.usage[key] !== binding.usage![key])) return null;
  return Object.freeze({ ...body, digest: value.digest });
}
