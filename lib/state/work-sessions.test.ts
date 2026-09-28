import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateLockConflictError, withStateLock } from "./store";
import { listWorkSessions, mutateWorkSessions, UnsupportedWorkSessionSchemaVersionError, WorkSessionStoreError } from "./work-sessions";
import type { WorkSession } from "./types";

let root: string | undefined;

function tempStore() {
  root = mkdtempSync(join(tmpdir(), "surtec-work-sessions-"));
  return { root, file: join(root, "state", "sessions", "work-sessions.json"), locks: join(root, "state", "locks") };
}

function activeSession(id = "ws_test"): WorkSession {
  return {
    schema_version: 1,
    id,
    project_id: "alpha",
    objective: "Implement a feature",
    status: "active",
    branch: "main",
    started_at: "2026-09-27T10:00:00.000Z",
    paused_at: null,
    completed_at: null,
    related_task_ids: [],
    related_run_ids: [],
    notes: [],
    result_summary: null,
    next_action: null,
    focused_ms: 0,
    active_since: "2026-09-27T10:00:00.000Z",
  };
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("work session state store", () => {
  it("reads an empty store and atomically persists versioned sessions", () => {
    const { file } = tempStore();
    expect(listWorkSessions(file)).toEqual([]);
    mutateWorkSessions((document) => { document.sessions.push(activeSession()); }, file);
    expect(listWorkSessions(file)).toEqual([activeSession()]);
  });

  it("does not replace valid state when a mutation violates the single-active-session invariant", () => {
    const { file } = tempStore();
    mutateWorkSessions((document) => { document.sessions.push(activeSession()); }, file);
    expect(() => mutateWorkSessions((document) => { document.sessions.push(activeSession("ws_second")); }, file)).toThrow(/multiple active sessions/);
    expect(listWorkSessions(file)).toEqual([activeSession()]);
  });

  it("fails safely on corrupt JSON and unsupported schema versions", () => {
    const { file } = tempStore();
    mkdirSync(join(root!, "state", "sessions"), { recursive: true });
    writeFileSync(file, "{", "utf8");
    expect(() => listWorkSessions(file)).toThrow(/invalid JSON/);
    writeFileSync(file, JSON.stringify({ schema_version: 2, sessions: [] }), "utf8");
    expect(() => listWorkSessions(file)).toThrow(UnsupportedWorkSessionSchemaVersionError);
  });

  it("rejects a second cooperating writer while the document lock is held", () => {
    const { file, locks } = tempStore();
    expect(() => withStateLock("work-sessions", () => mutateWorkSessions(() => {}, file), locks)).toThrow(StateLockConflictError);
  });

  it("rejects persisted documents that do not match the schema", () => {
    const { file } = tempStore();
    mkdirSync(join(root!, "state", "sessions"), { recursive: true });
    writeFileSync(file, JSON.stringify({ schema_version: 1, sessions: [{ ...activeSession(), branch: 4 }] }), "utf8");
    expect(() => listWorkSessions(file)).toThrow(WorkSessionStoreError);
  });

  it("does not write a document larger than the bounded store limit", () => {
    const { file } = tempStore();
    expect(() => mutateWorkSessions((document) => {
      for (let index = 0; index < 52; index += 1) {
        const session = activeSession(`ws_${index}`);
        session.status = "paused";
        session.active_since = null;
        session.paused_at = "2026-09-27T11:00:00.000Z";
        session.notes = Array.from({ length: 100 }, () => "x".repeat(2000));
        document.sessions.push(session);
      }
    }, file)).toThrow(/exceeds its size limit/);
    expect(listWorkSessions(file)).toEqual([]);
  });
});
