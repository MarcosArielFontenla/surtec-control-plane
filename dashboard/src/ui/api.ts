import { useEffect, useState } from "react";
import type { OverviewModel, RunRecord, ProjectCommands, RunEvent } from "../../../lib/state/types";

export async function fetchOverview(): Promise<OverviewModel> {
  const res = await fetch("/api/overview");
  if (!res.ok) throw new Error(`overview failed: ${res.status}`);
  return (await res.json()) as OverviewModel;
}

export function useOverview(intervalMs = 3000): { data: OverviewModel | null; error: string | null } {
  const [data, setData] = useState<OverviewModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const next = await fetchOverview();
        if (active) { setData(next); setError(null); }
      } catch (err) {
        if (active) setError((err as Error).message); // keep last good data
      }
    };
    void tick();
    const h = setInterval(tick, intervalMs);
    return () => { active = false; clearInterval(h); };
  }, [intervalMs]);

  return { data, error };
}

export interface DispatchOptions {
  projects: { project: string; agents: string[] }[];
}

export async function fetchDispatchOptions(): Promise<DispatchOptions> {
  const res = await fetch("/api/dispatch-options");
  if (!res.ok) throw new Error(`dispatch-options failed: ${res.status}`);
  return (await res.json()) as DispatchOptions;
}

export async function createTask(body: {
  project: string;
  agent: string;
  instructions: string;
  sandbox?: string;
  self_verify?: boolean;
}): Promise<{ id: string }> {
  const res = await fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `dispatch failed: ${res.status}`);
  }
  return (await res.json()) as { id: string };
}

async function decide(id: string, action: "approve" | "reject"): Promise<{ decision: unknown }> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/${action}`, { method: "POST" });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `${action} failed: ${res.status}`);
  }
  return (await res.json()) as { decision: unknown };
}

export function approveTask(id: string): Promise<{ decision: unknown }> {
  return decide(id, "approve");
}

export function rejectTask(id: string): Promise<{ decision: unknown }> {
  return decide(id, "reject");
}

export async function openProject(id: string, target: "vscode" | "folder"): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `open failed: ${res.status}`);
  }
}

export async function listRuns(): Promise<{ runs: RunRecord[] }> {
  const res = await fetch("/api/runs");
  if (!res.ok) throw new Error(`runs failed: ${res.status}`);
  return (await res.json()) as { runs: RunRecord[] };
}

export async function getProjectCommands(
  id: string,
): Promise<{ commands: ProjectCommands; running: { dev: string | null; oneshot: string | null } }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/commands`);
  if (!res.ok) throw new Error(`commands failed: ${res.status}`);
  return (await res.json()) as { commands: ProjectCommands; running: { dev: string | null; oneshot: string | null } };
}

export async function runProject(id: string, command: string): Promise<{ runId: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `run failed: ${res.status}`);
  }
  return (await res.json()) as { runId: string };
}

export async function stopRun(runId: string): Promise<void> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `stop failed: ${res.status}`);
  }
}

export async function getRun(runId: string): Promise<{ record: RunRecord; log: string }> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) throw new Error(`run failed: ${res.status}`);
  return (await res.json()) as { record: RunRecord; log: string };
}

// Opens an SSE stream for a run. Calls the matching handler per event and returns a close() fn.
export function streamRun(
  runId: string,
  on: { snapshot?: (s: { record: RunRecord; log: string }) => void; chunk?: (data: string) => void; status?: (r: RunRecord) => void },
): () => void {
  const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
  es.addEventListener("snapshot", (ev) => {
    const e = JSON.parse((ev as MessageEvent).data) as Extract<RunEvent, { type: "snapshot" }>;
    on.snapshot?.({ record: e.record, log: e.log });
  });
  es.addEventListener("chunk", (ev) => {
    const e = JSON.parse((ev as MessageEvent).data) as Extract<RunEvent, { type: "chunk" }>;
    on.chunk?.(e.data);
  });
  es.addEventListener("status", (ev) => {
    const e = JSON.parse((ev as MessageEvent).data) as Extract<RunEvent, { type: "status" }>;
    on.status?.(e.record);
    es.close();
  });
  es.addEventListener("error", () => es.close());
  return () => es.close();
}

export async function gitSync(
  id: string, action: "fetch" | "pull" | "push",
): Promise<{ ok: boolean; action: string; output: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/git`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `git ${action} failed: ${res.status}`);
  }
  return (await res.json()) as { ok: boolean; action: string; output: string };
}

export async function getBranches(id: string): Promise<{ branches: string[]; current: string | null }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/branches`);
  if (!res.ok) throw new Error(`branches failed: ${res.status}`);
  return (await res.json()) as { branches: string[]; current: string | null };
}

export async function branchOp(
  id: string, op: "switch" | "create", name: string,
): Promise<{ ok: boolean; output: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/branch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, name }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `branch ${op} failed: ${res.status}`);
  }
  return (await res.json()) as { ok: boolean; output: string };
}

export async function getGithubCounts(
  id: string,
): Promise<{ ok: boolean; prs: number; issues: number; ci: "passing" | "failing" | "running" | "none" | "unknown"; error?: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/github`);
  if (!res.ok) throw new Error(`github failed: ${res.status}`);
  return (await res.json()) as { ok: boolean; prs: number; issues: number; ci: "passing" | "failing" | "running" | "none" | "unknown"; error?: string };
}

export async function getDeps(id: string): Promise<{ ok: boolean; outdated: number; error?: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/deps`);
  if (!res.ok) throw new Error(`deps failed: ${res.status}`);
  return (await res.json()) as { ok: boolean; outdated: number; error?: string };
}
