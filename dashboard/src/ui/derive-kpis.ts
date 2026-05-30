import type { OverviewModel, RunRecord } from "../../../lib/state/types";

export interface Summary { total: number; configured: number; unconfigured: number; attention: number; }
export interface Kpi { value: string; foot: string; emphasis?: "ember" | "aurora"; }
export interface Kpis { projects: Kpi; inProgress: Kpi; attention: Kpi; uncommitted: Kpi; }

export function deriveSummary(data: OverviewModel): Summary {
  const total = data.projects.length;
  const configured = data.projects.filter((p) => p.configured).length;
  return { total, configured, unconfigured: total - configured, attention: data.attention.length };
}

export function deriveKpis(data: OverviewModel, _runs: RunRecord[]): Kpis {
  const { total, configured, unconfigured, attention } = deriveSummary(data);

  const running = data.inProgress.length;

  const byKind = (k: string) => data.attention.filter((a) => a.kind === k).length;
  const attnFoot = [
    [byKind("awaiting-approval"), "aprobar"],
    [byKind("risk"), "riesgo"],
    [byKind("blocker"), "bloqueo"],
    [byKind("needs-review"), "revisar"],
  ] as const;
  const attnParts = attnFoot.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);

  const dirtyRepos = data.projects.filter((p) => p.git?.ok && p.git.dirty);
  const uncommitted = dirtyRepos.reduce((sum, p) => sum + (p.git?.uncommitted ?? 0), 0);

  return {
    projects: { value: String(total), foot: `${configured} activos · ${unconfigured} descubiertos` },
    inProgress: { value: String(running), foot: running === 0 ? "sin tareas corriendo" : `${running} corriendo` },
    attention: {
      value: String(attention),
      foot: attnParts.length ? attnParts.join(" · ") : "todo en orden",
      emphasis: "ember",
    },
    uncommitted: { value: String(uncommitted), foot: `en ${dirtyRepos.length} repos`, emphasis: "aurora" },
  };
}
