import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentRunInput } from "./agent-executor";
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
          tokenUsage: { total: {}, last: { inputTokens: 11, cachedInputTokens: 3, cacheWriteInputTokens: 0, outputTokens: 7, reasoningOutputTokens: 2, totalTokens: 18 }, modelContextWindow: 1000 },
        },
      });
      server.send(completedTurn());
    });
  }
}

describe("CodexAppServerClient", () => {
  it("performs the handshake, starts a thread and turn, streams events, and returns usage", async () => {
    const server = new FakeAppServer(standardHandler);
    const events: AgentEvent[] = [];

    const result = await new CodexAppServerClient(server).run(input(), (event) => { events.push(event); }, new AbortController().signal);

    expect(server.received.map((message) => message.method)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    expect(server.received[2].params).toMatchObject({ cwd: "C:\\repo", sandbox: "read-only", developerInstructions: "root rules" });
    expect(server.received[3].params).toMatchObject({ cwd: "C:\\repo", input: [{ type: "text", text: "inspect", text_elements: [] }], outputSchema: { type: "object" }, sandboxPolicy: { type: "readOnly", networkAccess: false } });
    expect(result).toMatchObject({ structuredOutput: report, threadId: "thread-1", turnId: "turn-1" });
    expect(result.usage).toMatchObject({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
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
});
