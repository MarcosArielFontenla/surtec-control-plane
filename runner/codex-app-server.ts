import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { isCompleteAgentUsage, type AgentEvent, type AgentEventSink, type AgentRunInput, type AgentRunResult, type AgentUsage } from "./agent-executor";
import type { ServerNotification } from "./generated/codex-app-server/ServerNotification";
import type { InitializeParams } from "./generated/codex-app-server/InitializeParams";
import type { ConfigReadParams } from "./generated/codex-app-server/v2/ConfigReadParams";
import type { JsonValue } from "./generated/codex-app-server/serde_json/JsonValue";
import type { SandboxMode } from "./generated/codex-app-server/v2/SandboxMode";
import type { SandboxPolicy } from "./generated/codex-app-server/v2/SandboxPolicy";
import type { ThreadResumeParams } from "./generated/codex-app-server/v2/ThreadResumeParams";
import type { ThreadStartResponse } from "./generated/codex-app-server/v2/ThreadStartResponse";
import type { ThreadStartParams } from "./generated/codex-app-server/v2/ThreadStartParams";
import type { ThreadResumeResponse } from "./generated/codex-app-server/v2/ThreadResumeResponse";
import type { TurnInterruptParams } from "./generated/codex-app-server/v2/TurnInterruptParams";
import type { TurnStartParams } from "./generated/codex-app-server/v2/TurnStartParams";
import type { TurnStartResponse } from "./generated/codex-app-server/v2/TurnStartResponse";
import type { TurnCompletedNotification } from "./generated/codex-app-server/v2/TurnCompletedNotification";
import { isPathWithin } from "../lib/security/paths";
import { redactText } from "../lib/security/redaction";
import { createTerminalUsageEvidence, type TerminalUsageEvidence } from "./terminal-usage-evidence";
import { assertRuntimeContextConfiguration, GOVERNED_RUNTIME_CONTEXT_PROFILE, runtimeContextProfile, runtimeContextThreadConfig } from "./runtime-context-profile";

type RequestId = string | number;

export interface AppServerProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface TurnWaiter {
  threadId: string;
  turnId: string;
  resolve: (value: TurnCompletedNotification) => void;
  reject: (reason: Error) => void;
}

interface JsonObject {
  [key: string]: unknown;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
  return isObject(value) && typeof value[key] === "string" ? value[key] : null;
}

function abortError(message = "agent turn interrupted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

type ProtocolUsage = AgentUsage & { cacheWriteInputTokens: number };
const protocolUsageFields = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const;
const zeroUsage: ProtocolUsage = Object.freeze({ inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 });

function subtractUsage(total: ProtocolUsage, baseline: ProtocolUsage): ProtocolUsage | null {
  if (protocolUsageFields.some((field) => total[field] < baseline[field])) return null;
  return Object.freeze({
    inputTokens: total.inputTokens - baseline.inputTokens,
    cachedInputTokens: total.cachedInputTokens - baseline.cachedInputTokens,
    cacheWriteInputTokens: total.cacheWriteInputTokens - baseline.cacheWriteInputTokens,
    outputTokens: total.outputTokens - baseline.outputTokens,
    reasoningOutputTokens: total.reasoningOutputTokens - baseline.reasoningOutputTokens,
    totalTokens: total.totalTokens - baseline.totalTokens,
  });
}

function usageFrom(value: unknown): { last: ProtocolUsage; total: ProtocolUsage } | null {
  if (!isObject(value)) return null;
  const tokenUsage = isObject(value.tokenUsage) ? value.tokenUsage : null;
  const last = tokenUsage && isObject(tokenUsage.last) ? tokenUsage.last : null;
  const total = tokenUsage && isObject(tokenUsage.total) ? tokenUsage.total : null;
  const normalized = (counters: JsonObject | null): ProtocolUsage | null => {
    if (!counters || !Number.isSafeInteger(counters.cacheWriteInputTokens) || (counters.cacheWriteInputTokens as number) < 0) return null;
    const usage = {
      inputTokens: counters.inputTokens,
      cachedInputTokens: counters.cachedInputTokens,
      outputTokens: counters.outputTokens,
      reasoningOutputTokens: counters.reasoningOutputTokens,
      totalTokens: counters.totalTokens,
    };
    return isCompleteAgentUsage(usage) ? Object.freeze({ ...usage, cacheWriteInputTokens: counters.cacheWriteInputTokens as number }) : null;
  };
  const latest = normalized(last);
  const cumulative = normalized(total);
  return latest && cumulative ? { last: latest, total: cumulative } : null;
}

function usageHighWater(previous: AgentUsage | null, next: AgentUsage): AgentUsage {
  if (!previous) return Object.freeze({ ...next });
  return Object.freeze({
    inputTokens: Math.max(previous.inputTokens, next.inputTokens),
    cachedInputTokens: Math.max(previous.cachedInputTokens, next.cachedInputTokens),
    outputTokens: Math.max(previous.outputTokens, next.outputTokens),
    reasoningOutputTokens: Math.max(previous.reasoningOutputTokens, next.reasoningOutputTokens),
    totalTokens: Math.max(previous.totalTokens, next.totalTokens),
  });
}

function itemStatus(item: JsonObject): string | undefined {
  return typeof item.status === "string" ? item.status : undefined;
}

function sandboxMode(mode: AgentRunInput["mode"]): SandboxMode {
  return mode === "read-only" ? "read-only" : "workspace-write";
}

function sandboxPolicy(input: AgentRunInput): SandboxPolicy {
  if (input.mode === "read-only") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: [input.cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

export class CodexProtocolError extends Error {}

export class CodexAppServerClient {
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly completedTurns = new Map<string, TurnCompletedNotification>();
  private readonly lines: ReadLineInterface;
  private nextId = 1;
  private turnWaiter: TurnWaiter | null = null;
  private fatalError: Error | null = null;
  private stderrTail = "";
  private eventSink: AgentEventSink = () => {};
  private input: AgentRunInput | null = null;
  private finalText = "";
  private usage: AgentUsage | null = null;
  private provenUsage: AgentUsage | null = null;
  private usageBaseline: ProtocolUsage | null = null;
  private observedThreadUsage: ProtocolUsage | null = null;
  private exited = false;
  private closing = false;
  private notificationQueue: Promise<void> = Promise.resolve();
  private activeThreadId: string | null = null;
  private activeTurnId: string | null = null;
  private sequence = 0;
  private proofTainted = false;
  private lastActivitySequence = 0;
  private lastUsageSequence = 0;
  private finalItem: { id: string; sequence: number } | null = null;
  private readonly openItems = new Map<string, string>();
  private readonly serverRequests = new Set<Promise<void>>();
  private terminalSequence = 0;
  private terminalParsed = false;
  private terminal: TurnCompletedNotification | null = null;
  private unknownEmitted = false;
  private draining = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private stdoutEof = false;
  private stderrEof = false;
  private drainWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;

  constructor(private readonly process: AppServerProcess) {
    this.lines = createInterface({ input: process.stdout });
    process.stdin.on("error", () => this.fail(new CodexProtocolError("Codex App Server stdin stream failed")));
    this.lines.on("line", (line) => this.handleLine(line));
    for (const [name, stream] of [["stdout", process.stdout], ["stderr", process.stderr]] as const) {
      stream.on("end", () => {
        if (name === "stdout") this.stdoutEof = true; else this.stderrEof = true;
        this.checkDrain();
      });
      stream.on("error", () => this.fail(new CodexProtocolError(`Codex App Server ${name} stream failed`)));
      stream.on("close", () => {
        if (!stream.readableEnded && !this.closing) this.fail(new CodexProtocolError(`Codex App Server ${name} closed without EOF`));
      });
    }
    process.stderr.setEncoding("utf8");
    process.stderr.on("data", (chunk: string | Buffer) => {
      this.stderrTail = redactText((this.stderrTail + String(chunk)).slice(-4000));
    });
    process.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code; this.exitSignal = signal;
      if (this.fatalError || this.closing) return;
      if (this.terminalParsed && code === 0 && signal === null) { this.checkDrain(); return; }
      this.fail(new CodexProtocolError(
        `Codex App Server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})${this.stderrTail ? `: ${this.stderrTail}` : ""}`,
      ));
    });
  }

  async run(input: AgentRunInput, events: AgentEventSink, signal: AbortSignal): Promise<AgentRunResult> {
    this.input = input;
    this.eventSink = events;
    // A newly created thread has no historical inference to charge. On resume,
    // the first active response and subsequent cumulative deltas establish only
    // a lower bound; neither path proves a final provider total.
    this.usageBaseline = input.threadId ? null : zeroUsage;
    let activeThreadId: string | null = null;
    let activeTurnId: string | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const onAbort = () => {
      if (activeThreadId && activeTurnId) {
        const params: TurnInterruptParams = { threadId: activeThreadId, turnId: activeTurnId };
        void this.request("turn/interrupt", params).catch(() => {});
      } else {
        this.fail(abortError());
      }
      forceKillTimer = setTimeout(() => this.process.kill(), 1000);
      if (this.draining) this.fail(abortError());
    };

    if (signal.aborted) {
      this.close();
      throw abortError();
    }
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const profile = runtimeContextProfile(input.runtimeContextProfile);
      if (input.contextFingerprint !== undefined && (!/^[a-f0-9]{64}$/.test(input.contextFingerprint) ||
          (input.threadId && input.resumeContextFingerprint !== input.contextFingerprint))) {
        throw new CodexProtocolError("Thread context binding is invalid; a new confirmed task is required");
      }
      const initializeParams: InitializeParams = {
        clientInfo: { name: "surtec_control_plane", title: "Surtec Control Plane", version: "0.1.0" },
        capabilities: null,
      };
      await this.request("initialize", initializeParams);
      this.notify("initialized", {});

      if (profile === GOVERNED_RUNTIME_CONTEXT_PROFILE) {
        try {
          const response = await this.request("config/read", { includeLayers: false, cwd: input.cwd } satisfies ConfigReadParams);
          assertRuntimeContextConfiguration(response);
        } catch {
          // Effective configuration and native errors can contain private data.
          throw new CodexProtocolError("Required runtime context configuration was not confirmed");
        }
      }

      const common: Pick<ThreadStartParams, "cwd" | "approvalPolicy" | "approvalsReviewer" | "model" | "developerInstructions" | "config"> = {
        cwd: input.cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        model: input.model ?? null,
        developerInstructions: input.developerInstructions,
        config: {
          ...runtimeContextThreadConfig(profile),
          agents: { enabled: false },
          shell_environment_policy: { inherit: "core", ignore_default_excludes: false },
        },
      };

      const threadResponse = input.threadId
        ? await this.request<ThreadResumeResponse>("thread/resume", { threadId: input.threadId, sandbox: sandboxMode(input.mode), ...common } satisfies ThreadResumeParams)
        : await this.request<ThreadStartResponse>("thread/start", {
            sandbox: sandboxMode(input.mode),
            serviceName: "surtec_control_plane",
            ephemeral: false,
            ...common,
          } satisfies ThreadStartParams);

      activeThreadId = threadResponse.thread.id;
      this.activeThreadId = activeThreadId;
      await this.emit({ type: "thread-started", at: new Date().toISOString(), threadId: activeThreadId });

      const turnParams: TurnStartParams = {
        threadId: activeThreadId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        cwd: input.cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: sandboxPolicy(input),
        outputSchema: input.outputSchema as JsonValue,
      };
      if (input.model) turnParams.model = input.model;
      if (input.reasoningEffort) turnParams.effort = input.reasoningEffort;

      const turnResponse = await this.request<TurnStartResponse>("turn/start", turnParams);
      activeTurnId = turnResponse.turn.id;
      this.activeTurnId = activeTurnId;
      await this.emit({ type: "turn-started", at: new Date().toISOString(), threadId: activeThreadId, turnId: activeTurnId });

      const completion = await this.waitForTurn(activeThreadId, activeTurnId);
      if (signal.aborted || completion.turn.status === "interrupted") throw abortError();
      if (completion.turn.status !== "completed") {
        throw new Error(completion.turn.error?.message || `agent turn ended with status ${completion.turn.status}`);
      }

      let terminalUsageEvidence: TerminalUsageEvidence | undefined;
      if (this.canAttest()) {
        await this.drain();
        if (signal.aborted) throw abortError();
        if (this.fatalError) throw this.fatalError;
        if (this.canAttest() && this.exited && this.exitCode === 0 && this.exitSignal === null && this.stdoutEof && this.stderrEof) {
          try {
            terminalUsageEvidence = createTerminalUsageEvidence({
              ...input.executionIdentity!, contextFingerprint: input.contextFingerprint!, threadId: activeThreadId, turnId: activeTurnId,
              usage: this.usage!, baseline: zeroUsage, protocolUsage: this.observedThreadUsage!,
              finalItemId: this.finalItem!.id, finalPhase: "final_answer", finalItemSequence: this.finalItem!.sequence,
              usageSequence: this.lastUsageSequence, terminalSequence: this.terminalSequence, terminalStatus: "completed",
              exitCode: 0, signal: null, stdoutEof: true, stderrEof: true,
            });
          } catch { this.proofTainted = true; }
        }
      }
      if (!terminalUsageEvidence) await this.emitUnknown();

      let structuredOutput: unknown;
      try {
        structuredOutput = JSON.parse(this.finalText.trim());
      } catch {
        structuredOutput = undefined;
      }

      return {
        finalText: this.finalText,
        structuredOutput,
        threadId: activeThreadId,
        turnId: activeTurnId,
        usage: this.usage,
        // This attests only to a fresh, normally drained operational transcript.
        usageComplete: !!terminalUsageEvidence,
        ...(terminalUsageEvidence ? { terminalUsageEvidence } : {}),
        usageHighWater: this.provenUsage,
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      this.close();
    }
  }

  private request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: (value) => resolve(value as T), reject });
      try {
        this.write({ method, id, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: JsonObject): void {
    if (this.process.stdin.destroyed || !this.process.stdin.writable) {
      throw new CodexProtocolError("Codex App Server stdin is not writable");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(new CodexProtocolError("Codex App Server emitted malformed JSONL"));
      return;
    }
    if (!isObject(message)) {
      this.fail(new CodexProtocolError("Codex App Server emitted a non-object message"));
      return;
    }

    if ((typeof message.id === "string" || typeof message.id === "number") && typeof message.method !== "string") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (isObject(message.error)) {
        pending.reject(new CodexProtocolError(stringField(message.error, "message") || "App Server request failed"));
      } else {
        if ((pending.method === "thread/start" || pending.method === "thread/resume") && isObject(message.result)) {
          this.activeThreadId = stringField(message.result.thread, "id");
        }
        if (pending.method === "turn/start" && isObject(message.result)) {
          this.activeTurnId = stringField(message.result.turn, "id");
        }
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== "string") {
      this.fail(new CodexProtocolError("Codex App Server message has no method or response id"));
      return;
    }

    if (typeof message.id === "string" || typeof message.id === "number") {
      this.lastActivitySequence = ++this.sequence;
      if (this.terminalParsed) this.proofTainted = true;
      const request = this.handleServerRequest(message.id, message.method, message.params);
      this.serverRequests.add(request);
      void request.catch((error: Error) => this.fail(error)).finally(() => this.serverRequests.delete(request));
      return;
    }

    const sequence = ++this.sequence;
    if (message.method === "turn/completed" && isObject(message.params) && message.params.threadId === this.activeThreadId
      && isObject(message.params.turn) && message.params.turn.id === this.activeTurnId) this.terminalParsed = true;
    this.notificationQueue = this.notificationQueue
      .then(() => this.handleNotification(message as ServerNotification, sequence))
      .catch((error: Error) => this.fail(error));
  }

  private async handleServerRequest(id: RequestId, method: string, params: unknown): Promise<void> {
    const threadId = stringField(params, "threadId") ?? "";
    const turnId = stringField(params, "turnId") ?? "";
    const activeScope = threadId !== ""
      && turnId !== ""
      && threadId === this.activeThreadId
      && turnId === this.activeTurnId;
    if (method === "item/commandExecution/requestApproval") {
      const command = stringField(params, "command") ?? "";
      const commandCwd = stringField(params, "cwd");
      const allowed = activeScope
        && this.input?.mode === "workspace-write-verify"
        && (!commandCwd || isPathWithin(this.input.cwd, commandCwd))
        && (this.input.verifyCommands ?? []).some((candidate) => candidate.trim() === command.trim());
      await this.emit({ type: "approval", at: new Date().toISOString(), threadId, turnId, approval: "command", allowed, command });
      this.write({ id, result: { decision: allowed ? "accept" : "decline" } });
      return;
    }
    if (method === "item/fileChange/requestApproval") {
      const grantRoot = stringField(params, "grantRoot");
      const allowed = activeScope
        && this.input?.mode !== "read-only"
        && (!grantRoot || (this.input ? isPathWithin(this.input.cwd, grantRoot) : false));
      await this.emit({ type: "approval", at: new Date().toISOString(), threadId, turnId, approval: "file-change", allowed });
      this.write({ id, result: { decision: allowed ? "accept" : "decline" } });
      return;
    }

    await this.emit({ type: "approval", at: new Date().toISOString(), threadId, turnId, approval: "unsupported", allowed: false });
    this.write({ id, error: { code: -32601, message: `unsupported App Server request: ${method}` } });
  }

  private async handleNotification(notification: ServerNotification, sequence: number): Promise<void> {
    const at = new Date().toISOString();
    const params = notification.params as unknown;
    const threadId = stringField(params, "threadId") ?? "";
    const turnId = stringField(params, "turnId") ?? "";
    const active = threadId === this.activeThreadId && turnId === this.activeTurnId;
    if (this.terminal && notification.method !== "turn/completed" && (threadId || turnId)) this.proofTainted = true;

    switch (notification.method) {
      case "item/agentMessage/delta": {
        if (!active) { this.proofTainted = true; break; }
        this.lastActivitySequence = Math.max(this.lastActivitySequence, sequence);
        const delta = stringField(params, "delta") ?? "";
        this.finalText += delta;
        await this.emit({ type: "message-delta", at, threadId, turnId, delta });
        break;
      }
      case "item/started":
      case "item/completed": {
        if (!active) { this.proofTainted = true; break; }
        this.lastActivitySequence = Math.max(this.lastActivitySequence, sequence);
        const item = isObject(params) && isObject(params.item) ? params.item : null;
        if (!item) { this.proofTainted = true; break; }
        const itemType = stringField(item, "type") ?? "unknown";
        const itemId = stringField(item, "id") ?? "";
        if (!itemId || itemType === "unknown") this.proofTainted = true;
        if (notification.method === "item/started") {
          if (this.openItems.has(itemId)) this.proofTainted = true;
          this.openItems.set(itemId, itemType);
        } else {
          if (this.openItems.has(itemId) && this.openItems.get(itemId) !== itemType) this.proofTainted = true;
          this.openItems.delete(itemId);
          if (itemType === "agentMessage") this.finalItem = item.phase === "final_answer" ? { id: itemId, sequence } : null;
        }
        if (notification.method === "item/completed" && itemType === "agentMessage") {
          const text = stringField(item, "text");
          if (text !== null) this.finalText = text;
        }
        if (itemType !== "reasoning") {
          const event: AgentEvent = {
            type: "item",
            at,
            threadId,
            turnId,
            phase: notification.method === "item/started" ? "started" : "completed",
            itemId: stringField(item, "id") ?? "",
            itemType,
            status: itemStatus(item),
          };
          await this.emit(event);
        }
        break;
      }
      case "thread/tokenUsage/updated": {
        if (!threadId || !turnId || threadId !== this.activeThreadId || turnId !== this.activeTurnId) break;
        const snapshot = usageFrom(params);
        let usage: AgentUsage | null = null;
        if (snapshot && subtractUsage(snapshot.total, snapshot.last)
            && (!this.observedThreadUsage || subtractUsage(snapshot.total, this.observedThreadUsage))) {
          const baseline = this.usageBaseline ?? subtractUsage(snapshot.total, snapshot.last)!;
          const delta = subtractUsage(snapshot.total, baseline);
          if (delta) {
            this.usageBaseline = baseline;
            this.observedThreadUsage = snapshot.total;
            const { cacheWriteInputTokens: _cacheWrite, ...attributed } = delta;
            usage = Object.freeze(attributed);
          }
        }
        this.usage = usage;
        if (usage) {
          this.lastUsageSequence = sequence;
          this.provenUsage = usageHighWater(this.provenUsage, usage);
          await this.emit({ type: "usage", at, threadId, turnId, usage });
        } else {
          this.proofTainted = true;
          await this.emit({ type: "usage-unknown", at, threadId, turnId, reason: "invalid-usage" });
        }
        break;
      }
      case "warning":
      case "configWarning":
      case "error": {
        if (notification.method === "error") this.proofTainted = true;
        const directMessage = stringField(params, "message");
        const nestedError = isObject(params) && isObject(params.error) ? stringField(params.error, "message") : null;
        await this.emit({ type: "warning", at, threadId: threadId || undefined, turnId: turnId || undefined, message: directMessage || nestedError || notification.method });
        break;
      }
      case "turn/completed": {
        const completedTurnId = isObject(params) && isObject(params.turn) ? stringField(params.turn, "id") : null;
        if (!threadId || !completedTurnId || threadId !== this.activeThreadId || completedTurnId !== this.activeTurnId) {
          if (this.terminal) this.proofTainted = true;
          break;
        }
        const completed = notification.params as TurnCompletedNotification;
        if (this.terminal) {
          if (JSON.stringify(completed) !== JSON.stringify(this.terminal)) this.proofTainted = true;
          break;
        }
        this.terminal = completed; this.terminalSequence = sequence;
        if (!this.canAttest()) await this.emitUnknown();
        await this.emit({ type: "turn-completed", at, threadId: completed.threadId, turnId: completed.turn.id, status: completed.turn.status });
        this.completedTurns.set(completed.turn.id, completed);
        if (this.turnWaiter && this.turnWaiter.threadId === completed.threadId && this.turnWaiter.turnId === completed.turn.id) {
          const waiter = this.turnWaiter;
          this.turnWaiter = null;
          waiter.resolve(completed);
        }
        break;
      }
      default:
        break;
    }
  }

  private waitForTurn(threadId: string, turnId: string): Promise<TurnCompletedNotification> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const completed = this.completedTurns.get(turnId);
    if (completed?.threadId === threadId && completed.turn.id === turnId) return Promise.resolve(completed);
    return new Promise((resolve, reject) => {
      this.turnWaiter = { threadId, turnId, resolve, reject };
    });
  }

  private emit(event: AgentEvent): Promise<void> {
    return Promise.resolve(this.eventSink(event));
  }

  private fail(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = error;
    this.proofTainted = true;
    this.drainWaiter?.reject(error); this.drainWaiter = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (this.turnWaiter) {
      this.turnWaiter.reject(error);
      this.turnWaiter = null;
    }
    if (!this.exited) this.process.kill();
  }

  private close(): void {
    this.closing = true;
    this.lines.close();
    if (!this.exited) this.process.kill();
  }

  private canAttest(): boolean {
    return !this.proofTainted && !this.fatalError && !this.input?.threadId && !!this.input?.executionIdentity
      && !!this.input.contextFingerprint && !!this.usage && !!this.observedThreadUsage && !!this.finalItem
      && this.finalItem.sequence === this.lastActivitySequence && this.lastActivitySequence < this.lastUsageSequence
      && this.lastUsageSequence < this.terminalSequence && this.openItems.size === 0 && this.serverRequests.size === 0
      && this.pending.size === 0 && this.terminal?.turn.status === "completed" && this.terminal.turn.error === null;
  }

  private async emitUnknown(): Promise<void> {
    if (this.unknownEmitted || !this.activeThreadId || !this.activeTurnId) return;
    this.unknownEmitted = true;
    await this.emit({ type: "usage-unknown", at: new Date().toISOString(), threadId: this.activeThreadId,
      turnId: this.activeTurnId, reason: "final-usage-unproven" });
  }

  private checkDrain(): void {
    if (this.exited && this.stdoutEof && this.stderrEof) { this.drainWaiter?.resolve(); this.drainWaiter = null; }
  }

  private async drain(): Promise<void> {
    this.draining = true;
    await new Promise<void>((resolve, reject) => {
      this.drainWaiter = { resolve, reject };
      if (this.fatalError) { reject(this.fatalError); return; }
      this.process.stdin.end();
      this.checkDrain();
    });
    await this.notificationQueue;
    await Promise.all(this.serverRequests);
  }
}
