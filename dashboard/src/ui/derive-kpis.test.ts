import { describe, it, expect } from "vitest";
import { deriveKpis, deriveSummary } from "./derive-kpis";
import type { OverviewModel } from "../../../lib/state/types";

function model(over: Partial<OverviewModel> = {}): OverviewModel {
  return { projects: [], inProgress: [], history: [], attention: [], ...over };
}
const proj = (
  id: string,
  configured: boolean,
  git: Partial<NonNullable<OverviewModel["projects"][number]["git"]>> | null,
): OverviewModel["projects"][number] => ({
  id, status: "", health: null, note: null, repo: null, path: null, configured,
  git: git === null ? null : { branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true, ...git },
  last_activity: null, task_counts: { inProgress: 0, finished: 0 },
});

describe("deriveSummary", () => {
  it("counts totals, configured, unconfigured, and projects needing attention", () => {
    const m = model({
      projects: [proj("a", true, {}), proj("b", true, {}), proj("c", false, null)],
      attention: [
        { kind: "awaiting-approval", task_id: "T1", project: "a", title: "x" },
        { kind: "risk", task_id: "T2", project: "a", title: "y" },
      ],
    });
    expect(deriveSummary(m)).toEqual({ total: 3, configured: 2, unconfigured: 1, attention: 2 });
  });
});

describe("deriveKpis", () => {
  it("derives the four KPI cards from overview + runs", () => {
    const m = model({
      projects: [
        proj("a", true, { dirty: true, uncommitted: 5 }),
        proj("b", true, { dirty: true, uncommitted: 3 }),
        proj("c", false, null),
      ],
      inProgress: [{ id: "T9", project: "a", agent: "x", title: "t", lifecycle: "running", outcome: null, updated_at: "", finished_at: null, requires_human_approval: false, attempts: 1, max_attempts: 3, retry_at: null, cancel_requested_at: null }],
      attention: [
        { kind: "awaiting-approval", task_id: "T1", project: "a", title: "x" },
        { kind: "risk", task_id: "T2", project: "b", title: "y" },
        { kind: "blocker", task_id: "T3", project: "b", title: "z" },
      ],
    });
    const k = deriveKpis(m, []);
    expect(k.projects).toEqual({ value: "3", foot: "2 activos · 1 descubiertos" });
    expect(k.inProgress).toEqual({ value: "1", foot: "1 corriendo" });
    expect(k.attention).toEqual({ value: "3", foot: "1 aprobar · 1 riesgo · 1 bloqueo", emphasis: "ember" });
    expect(k.uncommitted).toEqual({ value: "8", foot: "en 2 repos", emphasis: "aurora" });
  });

  it("handles the empty/zero case", () => {
    const k = deriveKpis(model(), []);
    expect(k.inProgress).toEqual({ value: "0", foot: "sin tareas corriendo" });
    expect(k.uncommitted).toEqual({ value: "0", foot: "en 0 repos", emphasis: "aurora" });
    expect(k.attention.value).toBe("0");
  });
});
