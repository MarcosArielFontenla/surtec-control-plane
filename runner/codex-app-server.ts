import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { AgentEvent, AgentEventSink, AgentRunInput, AgentRunResult, AgentUsage } from "./agent-executor";
import type { ServerNotification } from "./generated/codex-app-server/ServerNotification";
import type { ThreadStartResponse } from "./generated/codex-app-server/v2/ThreadStartResponse";
import type { ThreadResumeResponse } from "./generated/codex-app-server/v2/ThreadResumeResponse";
import type { TurnStartResponse } from "./generated/codex-app-server/v2/TurnStartResponse";
import type { TurnCompletedNotification } from "./generated/codex-app-server/v2/TurnCompletedNotification";

type RequestId = string | number;

export interface AppServerProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface PendingRequest {
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

function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|bearer)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
}

function usageFrom(value: unknown): AgentUsage | null {
  if (!isObject(value)) return null;
  const tokenUsage = isObject(value.tokenUsage) ? value.tokenUsage : null;
  const last = tokenUsage && isObject(tokenUsage.last) ? tokenUsage.last : null;
  if (!last) return null;
  const number = (key: string): number => typeof last[key] === "number" ? last[key] : 0;
  return {
    inputTokens: number("inputTokens"),
    cachedInputTokens: number("cachedInputTokens"),
    outputTokens: number("outputTokens"),
    reasoningOutputTokens: number("reasoningOutputTokens"),
    totalTokens: number("totalTokens"),
  };
}

function itemStatus(item: JsonObject): string | undefined {
  return typeof item.status === "string" ? item.status : undefined;
}

function sandboxMode(mode: AgentRunInput["mode"]): "read-only" | "workspace-write" {
  return mode === "read-only" ? "read-only" : "workspace-write";
}

function sandboxPolicy(input: AgentRunInput): Record<string, unknown> {
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
  private exited = false;
  private closing = false;
  private notificationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly process: AppServerProcess) {
    this.lines = createInterface({ input: process.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    process.stderr.setEncoding("utf8");
    process.stderr.on("data", (chunk: string | Buffer) => {
      this.stderrTail = redactSecrets((this.stderrTail + String(chunk)).slice(-4000));
    });
    process.on("exit", (code, signal) => {
      this.exited = true;
      if (this.fatalError || this.closing) return;
      this.fail(new CodexProtocolError(
        `Codex App Server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})${this.stderrTail ? `: ${this.stderrTail}` : ""}`,
      ));
    });
  }

  async run(input: AgentRunInput, events: AgentEventSink, signal: AbortSignal): Promise<AgentRunResult> {
    this.input = input;
    this.eventSink = events;
    let activeThreadId: string | null = null;
    let activeTurnId: string | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const onAbort = () => {
      if (activeThreadId && activeTurnId) {
        void this.request("turn/interrupt", { threadId: activeThreadId, turnId: activeTurnId }).catch(() => {});
      } else {
        this.fail(abortError());
      }
      forceKillTimer = setTimeout(() => this.process.kill(), 1000);
    };

    if (signal.aborted) {
      this.close();
      throw abortError();
    }
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      await this.request("initialize", {
        clientInfo: { name: "surtec_control_plane", title: "Surtec Control Plane", version: "0.1.0" },
        capabilities: null,
      });
      this.notify("initialized", {});

      const common = {
        cwd: input.cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        model: input.model ?? null,
        developerInstructions: input.developerInstructions,
        config: {
          agents: { enabled: false },
          shell_environment_policy: { inherit: "core", ignore_default_excludes: false },
        },
      };

      const threadResponse = input.threadId
        ? await this.request<ThreadResumeResponse>("thread/resume", { threadId: input.threadId, sandbox: sandboxMode(input.mode), ...common })
        : await this.request<ThreadStartResponse>("thread/start", {
            sandbox: sandboxMode(input.mode),
            serviceName: "surtec_control_plane",
            ephemeral: false,
            ...common,
          });

      activeThreadId = threadResponse.thread.id;
      await this.emit({ type: "thread-started", at: new Date().toISOString(), threadId: activeThreadId });

      const turnParams: Record<string, unknown> = {
        threadId: activeThreadId,
        input: [{ type: "text", text: input.prompt }],
        cwd: input.cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: sandboxPolicy(input),
        outputSchema: input.outputSchema,
      };
      if (input.model) turnParams.model = input.model;
      if (input.reasoningEffort) turnParams.effort = input.reasoningEffort;

      const turnResponse = await this.request<TurnStartResponse>("turn/start", turnParams);
      activeTurnId = turnResponse.turn.id;
      await this.emit({ type: "turn-started", at: new Date().toISOString(), threadId: activeThreadId, turnId: activeTurnId });

      const completion = await this.waitForTurn(activeThreadId, activeTurnId);
      if (signal.aborted || completion.turn.status === "interrupted") throw abortError();
      if (completion.turn.status !== "completed") {
        throw new Error(completion.turn.error?.message || `agent turn ended with status ${completion.turn.status}`);
      }

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
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
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
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== "string") {
      this.fail(new CodexProtocolError("Codex App Server message has no method or response id"));
      return;
    }

    if (typeof message.id === "string" || typeof message.id === "number") {
      void this.handleServerRequest(message.id, message.method, message.params);
      return;
    }

    this.notificationQueue = this.notificationQueue
      .then(() => this.handleNotification(message as ServerNotification))
      .catch((error: Error) => this.fail(error));
  }

  private async handleServerRequest(id: RequestId, method: string, params: unknown): Promise<void> {
    const threadId = stringField(params, "threadId") ?? "";
    const turnId = stringField(params, "turnId") ?? "";
    if (method === "item/commandExecution/requestApproval") {
      const command = stringField(params, "command") ?? "";
      const allowed = this.input?.mode === "workspace-write-verify"
        && (this.input.verifyCommands ?? []).some((candidate) => candidate.trim() === command.trim());
      await this.emit({ type: "approval", at: new Date().toISOString(), threadId, turnId, approval: "command", allowed, command });
      this.write({ id, result: { decision: allowed ? "accept" : "decline" } });
      return;
    }
    if (method === "item/fileChange/requestApproval") {
      const allowed = this.input?.mode !== "read-only";
      await this.emit({ type: "approval", at: new Date().toISOString(), threadId, turnId, approval: "file-change", allowed });
      this.write({ id, result: { decision: allowed ? "accept" : "decline" } });
      return;
    }

    await this.emit({ type: "approval", at: new Date().toISOString(), threadId, turnId, approval: "unsupported", allowed: false });
    this.write({ id, error: { code: -32601, message: `unsupported App Server request: ${method}` } });
  }

  private async handleNotification(notification: ServerNotification): Promise<void> {
    const at = new Date().toISOString();
    const params = notification.params as unknown;
    const threadId = stringField(params, "threadId") ?? "";
    const turnId = stringField(params, "turnId") ?? "";

    switch (notification.method) {
      case "item/agentMessage/delta": {
        const delta = stringField(params, "delta") ?? "";
        this.finalText += delta;
        await this.emit({ type: "message-delta", at, threadId, turnId, delta });
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = isObject(params) && isObject(params.item) ? params.item : null;
        if (!item) break;
        const itemType = stringField(item, "type") ?? "unknown";
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
        const usage = usageFrom(params);
        if (usage) {
          this.usage = usage;
          await this.emit({ type: "usage", at, threadId, turnId, usage });
        }
        break;
      }
      case "warning":
      case "configWarning":
      case "error": {
        const directMessage = stringField(params, "message");
        const nestedError = isObject(params) && isObject(params.error) ? stringField(params.error, "message") : null;
        await this.emit({ type: "warning", at, threadId: threadId || undefined, turnId: turnId || undefined, message: directMessage || nestedError || notification.method });
        break;
      }
      case "turn/completed": {
        const completed = notification.params as TurnCompletedNotification;
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
    if (completed) return Promise.resolve(completed);
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
}
