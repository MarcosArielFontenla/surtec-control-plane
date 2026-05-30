// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { RunConsole } from "./RunConsole";

// Minimal controllable EventSource mock.
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners: Record<string, ((ev: { data: string }) => void)[]> = {};
  closed = false;
  constructor(url: string) { this.url = url; MockEventSource.instances.push(this); }
  addEventListener(type: string, cb: (ev: { data: string }) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  emit(type: string, data: unknown) {
    for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) });
  }
  close() { this.closed = true; }
}

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
});
afterEach(() => { vi.restoreAllMocks(); });

describe("RunConsole", () => {
  it("renders the snapshot log, appends chunks, and shows the terminal status", () => {
    const rec = { runId: "r1", projectId: "p", kind: "oneshot", command: "npm test",
      status: "running", pid: 1, startedAt: "t", endedAt: null, exitCode: null };
    render(<RunConsole runId="r1" />);
    const es = MockEventSource.instances[0];

    act(() => { es.emit("snapshot", { type: "snapshot", record: rec, log: "boot\n" }); });
    expect(screen.getByText(/boot/)).toBeInTheDocument();

    act(() => { es.emit("chunk", { type: "chunk", data: "running tests\n" }); });
    expect(screen.getByText(/running tests/)).toBeInTheDocument();

    act(() => { es.emit("status", { type: "status", record: { ...rec, status: "exited", exitCode: 0, endedAt: "t2" } }); });
    expect(screen.getByText(/exited/i)).toBeInTheDocument();
    expect(es.closed).toBe(true);
  });
});
