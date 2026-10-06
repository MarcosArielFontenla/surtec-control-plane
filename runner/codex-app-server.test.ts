import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { isCompleteAgentUsage, type AgentEvent, type AgentRunInput, type AgentUsage } from "./agent-executor";
import { CodexAppServerClient, CodexProtocolError, type AppServerProcess } from "./codex-app-server";

type WireMessage = Record<string, unknown>;

class FakeAppServer extends EventEmitter implements AppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: WireMessage[] = [];
  killed = false;
  private inputBuffer = "";

  constructor(private readonly handler: (message: WireMessage, server: FakeAppServer) => void) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.inputBuffer += chunk;
      while (this.inputBuffer.includes("\n")) {
        const newline = this.inputBuffer.indexOf("\n");
        const line = this.inputBuffer.slice(0, newline);
        this.inputBuffer = this.inputBuffer.slice(newline + 1);
        const message = JSON.parse(line) as WireMessage;
        this.received.push(message);
        this.handler(message, this);
      }
    });
  }

  send(message: WireMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(line: string): void {
    this.stdout.write(`${line}\n`);
  }

  exitUnexpectedly(code = 1): void {
    this.emit("exit", code, null);
  }

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

const report = {
  status: "completed",
  summary: "inspected",
  commands_run: [],
  tests_run: [],
  risks: [],
  blockers: [],
  next_steps: [],
  artifacts: [],
};

const observedUsage = { inputTokens: 11, cachedInputTokens: 3, cacheWriteInputTokens: 0, outputTokens: 7, reasoningOutputTokens: 2, totalTokens: 18 };
const protocolUsageFields = Object.keys(observedUsage);
const internalUsage: AgentUsage = { inputTokens: 11, cachedInputTokens: 3, outputTokens: 7, reasoningOutputTokens: 2, totalTokens: 18 };
const invalidCounters: Array<[string, unknown]> = [["missing", undefined], ["null", null], ["negative", -1], ["fractional", 1.5], ["unsafe", Number.MAX_SAFE_INTEGER + 1], ["string", "0"], ["boolean", false]];

function usageNotification(tokenUsage: unknown, threadId = "thread-1", turnId = "turn-1"): WireMessage {
  return { method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage } };
}

function usagePayload(last: unknown = observedUsage, total: unknown = observedUsage): WireMessage {
  return { last, total, modelContextWindow: 1000 };
}

async function runUsageNotifications(notifications: Array<WireMessage | string>, completion: WireMessage = completedTurn()) {
  const events: AgentEvent[] = [];
  const server = new FakeAppServer((message, current) => {
    if (message.method === "initialize") current.send({ id: message.id, result: {} });
    if (message.method === "thread/start" || message.method === "thread/resume") current.send({ id: message.id, result: { thread: { id: "thread-1" } } });
    if (message.method === "turn/start") {
      current.send({ id: message.id, result: { turn: { id: "turn-1" } } });
      queueMicrotask(() => {
        current.send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "item-1", type: "agentMessage", text: JSON.stringify(report), phase: "final" } } });
        for (const notification of notifications) {
          if (typeof notification === "string") current.sendRaw(notification);
          else current.send(notification);
        }
        current.send(completion);
      });
    }
  });
  const result = await new CodexAppServerClient(server).run(input(), (event) => { events.push(event); }, new AbortController().signal);
  expect(server.killed).toBe(true);
  return { result, events, server };
}

function input(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    cwd: "C:\\repo",
    developerInstructions: "root rules",
    prompt: "inspect",
    mode: "read-only",
    outputSchema: { type: "object" },
    ...overrides,
  };
}

function completedTurn(status = "completed"): WireMessage {
  return {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", items: [], itemsView: { type: "full" }, status, error: null, startedAt: 1, completedAt: 2, durationMs: 1000 },
    },
  };
}

function standardHandler(message: WireMessage, server: FakeAppServer): void {
  if (message.method === "initialize") server.send({ id: message.id, result: { userAgent: "fake" } });
  if (message.method === "thread/start") server.send({ id: message.id, result: { thread: { id: "thread-1" } } });
  if (message.method === "thread/resume") server.send({ id: message.id, result: { thread: { id: "thread-1" } } });
  if (message.method === "turn/start") {
    server.send({ id: message.id, result: { turn: { id: "turn-1" } } });
    queueMicrotask(() => {
      const text = JSON.stringify(report);
      server.send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: text } });
      server.send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", completedAtMs: 2, item: { id: "item-1", type: "agentMessage", text, phase: "final" } } });
      server.send({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1", turnId: "turn-1",
          tokenUsage: usagePayload(),
        },
      });
      server.send(completedTurn());
    });
  }
}

describe("CodexAppServerClient", () => {
  it.each([undefined, "b".repeat(64)])("rejects mismatched governed thread bindings before even initializing", async (resumeContextFingerprint) => {
    const server = new FakeAppServer(standardHandler);
    await expect(new CodexAppServerClient(server).run(input({ threadId: "thread-1", contextFingerprint: "a".repeat(64), resumeContextFingerprint }), () => {}, new AbortController().signal)).rejects.toThrow(/binding/);
    expect(server.received).toEqual([]); expect(server.killed).toBe(true);
  });
  it("resumes a matching governed contract without forwarding internal binding fields", async () => {
    const server = new FakeAppServer(standardHandler);
    await new CodexAppServerClient(server).run(input({ threadId: "thread-1", contextFingerprint: "a".repeat(64), resumeContextFingerprint: "a".repeat(64) }), () => {}, new AbortController().signal);
    expect(server.received.some((message) => message.method === "thread/resume")).toBe(true);
    expect(JSON.stringify(server.received)).not.toContain("contextFingerprint");
  });
  it("performs the handshake, starts a thread and turn, streams events, and returns usage", async () => {
    const server = new FakeAppServer(standardHandler);
    const events: AgentEvent[] = [];

    const result = await new CodexAppServerClient(server).run(input(), (event) => { events.push(event); }, new AbortController().signal);

    expect(server.received.map((message) => message.method)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    expect(server.received[2].params).toMatchObject({ cwd: "C:\\repo", sandbox: "read-only", developerInstructions: "root rules" });
    expect(server.received[3].params).toMatchObject({ cwd: "C:\\repo", input: [{ type: "text", text: "inspect", text_elements: [] }], outputSchema: { type: "object" }, sandboxPolicy: { type: "readOnly", networkAccess: false } });
    expect(result).toMatchObject({ structuredOutput: report, threadId: "thread-1", turnId: "turn-1" });
    expect(result.usage).toMatchObject({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
    expect(result.usageHighWater).toEqual(internalUsage);
    expect(result.usageComplete).toBe(false);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["thread-started", "turn-started", "message-delta", "item", "usage", "turn-completed"]));
    expect(server.killed).toBe(true);
  });

  it("resumes a requested thread instead of starting one", async () => {
    const server = new FakeAppServer(standardHandler);

    await new CodexAppServerClient(server).run(input({ threadId: "thread-1" }), () => {}, new AbortController().signal);

    expect(server.received.some((message) => message.method === "thread/resume")).toBe(true);
    expect(server.received.some((message) => message.method === "thread/start")).toBe(false);
  });

  it("accepts only an exact configured verification approval", async () => {
    let approvalResponse: WireMessage | undefined;
    const server = new FakeAppServer((message, current) => {
      if (message.method === "initialize") current.send({ id: message.id, result: {} });
      if (message.method === "thread/start") current.send({ id: message.id, result: { thread: { id: "thread-1" } } });
      if (message.method === "turn/start") {
        current.send({ id: message.id, result: { turn: { id: "turn-1" } } });
        queueMicrotask(() => current.send({ id: 99, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", command: "pnpm test" } }));
      }
      if (message.id === 99 && !message.method) {
        approvalResponse = message;
        current.send(completedTurn());
      }
    });

    await new CodexAppServerClient(server).run(
      input({ mode: "workspace-write-verify", verifyCommands: ["pnpm test"] }),
      () => {},
      new AbortController().signal,
    );

    expect(approvalResponse).toMatchObject({ id: 99, result: { decision: "accept" } });
  });

  it("declines unconfigured commands", async () => {
    let decision: unknown;
    const server = new FakeAppServer((message, current) => {
      if (message.method === "initialize") current.send({ id: message.id, result: {} });
      if (message.method === "thread/start") current.send({ id: message.id, result: { thread: { id: "thread-1" } } });
      if (message.method === "turn/start") {
        current.send({ id: message.id, result: { turn: { id: "turn-1" } } });
        queueMicrotask(() => current.send({ id: 88, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", command: "unknown command" } }));
      }
      if (message.id === 88 && !message.method) {
        decision = message.result;
        current.send(completedTurn());
      }
    });

    await new CodexAppServerClient(server).run(input({ mode: "workspace-write-verify", verifyCommands: ["pnpm test"] }), () => {}, new AbortController().signal);

    expect(decision).toEqual({ decision: "decline" });
  });

  it("declines an otherwise valid approval from a different turn", async () => {
    let decision: unknown;
    const server = new FakeAppServer((message, current) => {
      if (message.method === "initialize") current.send({ id: message.id, result: {} });
      if (message.method === "thread/start") current.send({ id: message.id, result: { thread: { id: "thread-1" } } });
      if (message.method === "turn/start") {
        current.send({ id: message.id, result: { turn: { id: "turn-1" } } });
        queueMicrotask(() => current.send({ id: 89, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "forged-turn", command: "pnpm test" } }));
      }
      if (message.id === 89 && !message.method) {
        decision = message.result;
        current.send(completedTurn());
      }
    });

    await new CodexAppServerClient(server).run(input({ mode: "workspace-write-verify", verifyCommands: ["pnpm test"] }), () => {}, new AbortController().signal);

    expect(decision).toEqual({ decision: "decline" });
  });

  it("declines a write approval that asks to expand outside the worktree", async () => {
    let decision: unknown;
    const server = new FakeAppServer((message, current) => {
      if (message.method === "initialize") current.send({ id: message.id, result: {} });
      if (message.method === "thread/start") current.send({ id: message.id, result: { thread: { id: "thread-1" } } });
      if (message.method === "turn/start") {
        current.send({ id: message.id, result: { turn: { id: "turn-1" } } });
        queueMicrotask(() => current.send({ id: 77, method: "item/fileChange/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", grantRoot: "C:\\outside" } }));
      }
      if (message.id === 77 && !message.method) {
        decision = message.result;
        current.send(completedTurn());
      }
    });

    await new CodexAppServerClient(server).run(input({ mode: "workspace-write" }), () => {}, new AbortController().signal);

    expect(decision).toEqual({ decision: "decline" });
  });

  it("fails closed on malformed JSONL", async () => {
    const server = new FakeAppServer((message, current) => {
      if (message.method === "initialize") current.send({ id: message.id, result: {} });
      if (message.method === "thread/start") current.send({ id: message.id, result: { thread: { id: "thread-1" } } });
      if (message.method === "turn/start") {
        current.send({ id: message.id, result: { turn: { id: "turn-1" } } });
        queueMicrotask(() => current.sendRaw("{"));
      }
    });

    await expect(new CodexAppServerClient(server).run(input(), () => {}, new AbortController().signal))
      .rejects.toThrow("malformed JSONL");
  });

  it("reports an unexpected process exit", async () => {
    const server = new FakeAppServer((message, current) => {
      if (message.method === "initialize") current.send({ id: message.id, result: {} });
      if (message.method === "thread/start") current.send({ id: message.id, result: { thread: { id: "thread-1" } } });
      if (message.method === "turn/start") {
        current.send({ id: message.id, result: { turn: { id: "turn-1" } } });
        queueMicrotask(() => current.exitUnexpectedly(23));
      }
    });

    await expect(new CodexAppServerClient(server).run(input(), () => {}, new AbortController().signal))
      .rejects.toThrow("code=23");
  });

  it("requests interruption and rejects with AbortError when cancelled", async () => {
    const controller = new AbortController();
    const server = new FakeAppServer((message, current) => {
      if (message.method === "initialize") current.send({ id: message.id, result: {} });
      if (message.method === "thread/start") current.send({ id: message.id, result: { thread: { id: "thread-1" } } });
      if (message.method === "turn/start") {
        current.send({ id: message.id, result: { turn: { id: "turn-1" } } });
      }
      if (message.method === "turn/interrupt") {
        current.send({ id: message.id, result: {} });
        current.send(completedTurn("interrupted"));
      }
    });

    const error = await new CodexAppServerClient(server).run(input(), (event) => {
      if (event.type === "turn-started") controller.abort();
    }, controller.signal).catch((caught: Error) => caught) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AbortError");
    expect(server.received.some((message) => message.method === "turn/interrupt")).toBe(true);
  });

  it("closes immediately when passed an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const server = new FakeAppServer(() => {});

    await expect(new CodexAppServerClient(server).run(input(), () => {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(server.killed).toBe(true);
  });

  it("uses a distinct protocol error type", () => {
    expect(new CodexProtocolError("x")).toBeInstanceOf(Error);
  });

  it("does not invent zero usage when the turn completes without a usage notification", async () => {
    const { result, events } = await runUsageNotifications([]);
    expect(result.usage).toBeNull();
    expect(result.usageHighWater).toBeNull();
    expect(result.usageComplete).toBe(false);
    expect(events.filter((event) => event.type === "usage")).toEqual([]);
    expect(events.filter((event) => event.type === "usage-unknown")).toEqual([
      expect.objectContaining({ threadId: "thread-1", turnId: "turn-1", reason: "final-usage-unproven" }),
    ]);
  });

  it.each([null, {}, [], { last: observedUsage }, { total: observedUsage }, { last: null, total: observedUsage }, { last: observedUsage, total: null }].map((payload, index) => ({ payload, index })))(
    "keeps absent or incomplete usage unknown: $index", async ({ payload }) => {
      const { result, events } = await runUsageNotifications([usageNotification(payload)]);
      expect(result.usage).toBeNull();
      expect(result.usageHighWater).toBeNull();
      expect(result.usageComplete).toBe(false);
      expect(events.filter((event) => event.type === "usage")).toEqual([]);
      expect(events).toContainEqual(expect.objectContaining({ type: "usage-unknown", reason: "invalid-usage" }));
    },
  );

  const invalidProtocolCases = ["last", "total"].flatMap((side) => protocolUsageFields.flatMap((field) => invalidCounters.map(([label, value]) => ({ side, field, label, value }))));
  it.each(invalidProtocolCases)("rejects $side counter $field ($label) without replacing it with zero", async ({ side, field, value }) => {
    const counters: Record<string, unknown> = { ...observedUsage, [field]: value };
    const payload = usagePayload(); payload[side] = counters;
    const { result, events } = await runUsageNotifications([usageNotification(payload)]);
    expect(result.usage).toBeNull(); expect(result.usageHighWater).toBeNull(); expect(result.usageComplete).toBe(false);
    expect(events.filter((event) => event.type === "usage")).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: "usage-unknown", reason: "invalid-usage" }));
  });

  it.each(["last", "total"].flatMap((side) => protocolUsageFields.map((field) => ({ side, field }))))("rejects non-finite $side counter $field from valid JSON numeric overflow", async ({ side, field }) => {
    const counters = { ...observedUsage, [field]: "OVERFLOW_NUMBER" };
    const payload = usagePayload(); payload[side] = counters;
    const raw = JSON.stringify(usageNotification(payload)).replace('"OVERFLOW_NUMBER"', "1e400");
    const { result, events } = await runUsageNotifications([raw]);
    expect(result.usage).toBeNull(); expect(result.usageHighWater).toBeNull(); expect(result.usageComplete).toBe(false);
    expect(events.filter((event) => event.type === "usage")).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: "usage-unknown", reason: "invalid-usage" }));
  });

  it("preserves complete explicit zero as an observation, not a proven final total", async () => {
    const zero = Object.fromEntries(protocolUsageFields.map((field) => [field, 0]));
    const { result, events } = await runUsageNotifications([usageNotification(usagePayload(zero, zero))]);
    const expected = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
    expect(result.usage).toEqual(expected); expect(result.usageHighWater).toEqual(expected); expect(result.usageComplete).toBe(false);
    expect(events.filter((event) => event.type === "usage")).toEqual([expect.objectContaining({ usage: expected })]);
    expect(events.at(-2)).toMatchObject({ type: "usage-unknown", reason: "final-usage-unproven" });
  });

  it("keeps proven high-water after a later invalid notification and never declares its missing final total complete", async () => {
    const { result, events } = await runUsageNotifications([usageNotification(usagePayload()), usageNotification(usagePayload({ ...observedUsage, totalTokens: null }))]);
    expect(result.usage).toBeNull(); expect(result.usageHighWater).toEqual(internalUsage); expect(result.usageComplete).toBe(false);
    expect(events.filter((event) => event.type === "usage")).toEqual([expect.objectContaining({ usage: internalUsage })]);
    expect(events.filter((event) => event.type === "usage-unknown").map((event) => event.reason)).toEqual(["invalid-usage", "final-usage-unproven"]);
  });

  it("retains observed excess, ignores duplicate/decreasing high-water and can retain a later valid sample without claiming completeness", async () => {
    const high = { ...observedUsage, inputTokens: 100, outputTokens: 40, totalTokens: 140 };
    const low = { ...observedUsage, inputTokens: 2, outputTokens: 1, totalTokens: 3 };
    const { result, events } = await runUsageNotifications([
      usageNotification(usagePayload(high, high)), usageNotification(usagePayload(high, high)),
      usageNotification(usagePayload(null)), usageNotification(usagePayload(low, low)),
    ]);
    expect(result.usage).toEqual({ inputTokens: 2, cachedInputTokens: 3, outputTokens: 1, reasoningOutputTokens: 2, totalTokens: 3 });
    expect(result.usageHighWater).toEqual({ ...internalUsage, inputTokens: 100, outputTokens: 40, totalTokens: 140 });
    expect(result.usageComplete).toBe(false);
    expect(events.filter((event) => event.type === "usage")).toHaveLength(3);
  });

  it.each([["other-thread", "turn-1"], ["thread-1", "other-turn"], ["", "turn-1"], ["thread-1", ""]])("ignores usage bound to %s/%s, including invalid samples", async (threadId, turnId) => {
    const { result, events } = await runUsageNotifications([
      usageNotification(usagePayload(), threadId, turnId), usageNotification(null, threadId, turnId),
    ]);
    expect(result.usage).toBeNull(); expect(result.usageHighWater).toBeNull();
    expect(events.filter((event) => event.type === "usage")).toEqual([]);
    expect(events.filter((event) => event.type === "usage-unknown").map((event) => event.reason)).toEqual(["final-usage-unproven"]);
  });

  it("does not let wrong-bound usage erase known active-turn observations", async () => {
    const { result, events } = await runUsageNotifications([usageNotification(usagePayload()), usageNotification(null, "other-thread", "turn-1")]);
    expect(result.usage).toEqual(internalUsage); expect(result.usageHighWater).toEqual(internalUsage);
    expect(events.filter((event) => event.type === "usage-unknown").map((event) => event.reason)).toEqual(["final-usage-unproven"]);
  });

  it("detaches normalized observations and high-water from mutable protocol payloads and event consumers", async () => {
    const payload = usagePayload({ ...observedUsage }, { ...observedUsage });
    const { result, events } = await runUsageNotifications([usageNotification(payload)]);
    (payload.last as Record<string, unknown>).totalTokens = 999;
    const usageEvent = events.find((event) => event.type === "usage");
    expect(usageEvent?.type).toBe("usage");
    if (usageEvent?.type === "usage") {
      expect(Object.isFrozen(usageEvent.usage)).toBe(true);
      expect(() => { usageEvent.usage.totalTokens = 999; }).toThrow(TypeError);
    }
    expect(Object.isFrozen(result.usageHighWater)).toBe(true);
    expect(() => { result.usageHighWater!.totalTokens = 999; }).toThrow(TypeError);
    expect(result.usage).toEqual(internalUsage); expect(result.usageHighWater).toEqual(internalUsage);
  });

  it.each(["other-thread", "thread-1"])("ignores wrong completion identity from %s during the cached/waiter race", async (threadId) => {
    const wrong = completedTurn("failed");
    const params = wrong.params as { threadId: string; turn: { id: string } };
    params.threadId = threadId; if (threadId === "thread-1") params.turn.id = "other-turn";
    const { result, events } = await runUsageNotifications([wrong, usageNotification(usagePayload())]);
    expect(result.structuredOutput).toEqual(report);
    expect(events.filter((event) => event.type === "turn-completed")).toEqual([expect.objectContaining({ threadId: "thread-1", turnId: "turn-1", status: "completed" })]);
    expect(result.usageHighWater).toEqual(internalUsage);
  });

  it("does not resolve a cached wrong-thread completion with the active turn id before installing the waiter", async () => {
    const events: AgentEvent[] = [];
    let releaseTurnStarted!: () => void;
    const heldTurnStarted = new Promise<void>((resolve) => { releaseTurnStarted = resolve; });
    let sendActualCompletion!: () => void;
    const server = new FakeAppServer((message, current) => {
      if (message.method === "initialize") current.send({ id: message.id, result: {} });
      if (message.method === "thread/start") current.send({ id: message.id, result: { thread: { id: "thread-1" } } });
      if (message.method === "turn/start") {
        current.send({ id: message.id, result: { turn: { id: "turn-1" } } });
        const foreign = completedTurn("failed"); (foreign.params as Record<string, unknown>).threadId = "other-thread";
        queueMicrotask(() => current.send(foreign));
        sendActualCompletion = () => current.send(completedTurn());
      }
    });
    let terminal = false;
    const run = new CodexAppServerClient(server).run(input(), (event) => {
      events.push(event);
      if (event.type === "turn-started") return heldTurnStarted;
    }, new AbortController().signal);
    const tracked = run.then((result) => { terminal = true; return result; }, (error: unknown) => { terminal = true; throw error; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sendActualCompletion).toBeTypeOf("function");
    releaseTurnStarted();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminal).toBe(false);
    expect(events.some((event) => event.type === "turn-completed")).toBe(false);
    sendActualCompletion();
    const result = await tracked;
    expect(result.threadId).toBe("thread-1"); expect(result.turnId).toBe("turn-1"); expect(result.usageComplete).toBe(false);
    expect(events.filter((event) => event.type === "turn-completed")).toHaveLength(1);
    expect(server.killed).toBe(true);
  });

  it("does not accept an absent completion turn id before the active turn is known", async () => {
    const events: AgentEvent[] = [];
    const server = new FakeAppServer((message, current) => {
      if (message.method === "thread/start") {
        current.send({ id: message.id, result: { thread: { id: "thread-1" } } });
        current.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "failed" } } });
      } else {
        standardHandler(message, current);
      }
    });
    const result = await new CodexAppServerClient(server).run(input(), (event) => { events.push(event); }, new AbortController().signal);
    expect(result.structuredOutput).toEqual(report);
    expect(events.filter((event) => event.type === "turn-completed")).toEqual([expect.objectContaining({ turnId: "turn-1", status: "completed" })]);
    expect(events.filter((event) => event.type === "usage-unknown")).toEqual([expect.objectContaining({ turnId: "turn-1", reason: "final-usage-unproven" })]);
    expect(server.killed).toBe(true);
  });
});

describe("isCompleteAgentUsage", () => {
  it("accepts exactly five safe numeric own data fields, including explicit zero", () => {
    expect(isCompleteAgentUsage(internalUsage)).toBe(true);
    expect(isCompleteAgentUsage(Object.fromEntries(Object.keys(internalUsage).map((key) => [key, 0])))).toBe(true);
    expect(isCompleteAgentUsage(Object.assign(Object.create(null), internalUsage))).toBe(true);
  });

  it.each(Object.keys(internalUsage).flatMap((field) => [...invalidCounters, ["NaN", NaN], ["Infinity", Infinity], ["negativeInfinity", -Infinity]].map(([label, value]) => ({ field, label, value }))))("refuses internal $field $label", ({ field, value }) => {
    expect(isCompleteAgentUsage({ ...internalUsage, [field]: value })).toBe(false);
  });

  it("refuses hooks, inherited, hidden, symbols, arrays, extra fields and proxies without invoking hooks", () => {
    let hooks = 0;
    const accessor = { ...internalUsage }; Object.defineProperty(accessor, "totalTokens", { enumerable: true, get: () => { hooks++; return 18; } });
    const hidden = { ...internalUsage }; Object.defineProperty(hidden, "totalTokens", { enumerable: false, value: 18 });
    const proxy = new Proxy(internalUsage, { ownKeys: () => { hooks++; throw new Error("must not run"); } });
    const candidates = [null, undefined, [], Object.create(internalUsage), accessor, hidden, proxy, { ...internalUsage, [Symbol("x")]: 0 }, { ...internalUsage, extra: 0 }, { ...internalUsage, toJSON: () => { hooks++; return internalUsage; } }];
    for (const value of candidates) expect(isCompleteAgentUsage(value)).toBe(false);
    expect(hooks).toBe(0);
  });
});
