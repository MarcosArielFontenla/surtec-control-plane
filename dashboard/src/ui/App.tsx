import { useState } from "react";
import { useOverview } from "./api";
import { Sidebar, type NavItem } from "./components/Sidebar";
import { ProjectCard } from "./components/ProjectCard";
import { AttentionPanel } from "./components/AttentionPanel";
import { NewTaskForm } from "./components/NewTaskForm";
import { KpiStrip } from "./components/KpiStrip";
import { InProgressColumn } from "./components/InProgressColumn";
import { ProcesosView } from "./views/ProcesosView";
import { IssuesView } from "./views/IssuesView";
import { useRuns } from "./useRuns";
import { deriveKpis, deriveSummary } from "./derive-kpis";

const ANCHOR: Partial<Record<NavItem, string>> = { Proyectos: "sec-proyectos", Tareas: "sec-tareas", "Atención": "sec-atencion" };

export function App() {
  const { data, error } = useOverview();
  const { runs } = useRuns();
  const [nav, setNav] = useState<NavItem>("Overview");

  const runningByProject = new Map<string, string[]>();
  for (const r of runs) {
    if (r.status !== "running") continue;
    const label = r.kind === "dev" ? "dev" : "en curso";
    runningByProject.set(r.projectId, [...(runningByProject.get(r.projectId) ?? []), label]);
  }

  const summary = data ? deriveSummary(data) : { total: 0, configured: 0, unconfigured: 0, attention: 0 };
  const kpis = data ? deriveKpis(data, runs) : null;
  const view: "Overview" | "Procesos" | "Issues" =
    nav === "Procesos" ? "Procesos" : nav === "Issues" ? "Issues" : "Overview";

  const onSelect = (item: NavItem) => {
    if (item === "Overview" || item === "Procesos" || item === "Issues") { setNav(item); return; }
    setNav("Overview");
    const id = ANCHOR[item];
    if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const activeProjectIds = data ? data.projects.filter((p) => p.configured).map((p) => p.id) : [];
  const gitProjectIds = data ? data.projects.filter((p) => p.git?.ok).map((p) => p.id) : [];

  return (
    <div className="app">
      <Sidebar active={nav} onSelect={onSelect} summary={summary} connected={!error} />
      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <h1>{view === "Procesos" ? "Procesos" : view === "Issues" ? "Issues" : "Estado vivo"}</h1>
            <span className="sub">{summary.total} repos · {data?.inProgress.length ?? 0} tareas activas</span>
          </div>
          <span className={`live${error ? " live--down" : ""}`}>
            <span className="dot" />{error ? "Sin conexión" : "En vivo"}
          </span>
        </header>

        <div className="wrap">
          {view === "Procesos" ? (
            <ProcesosView projectIds={activeProjectIds} />
          ) : view === "Issues" ? (
            <IssuesView />
          ) : (
            <>
              {kpis && <KpiStrip kpis={kpis} />}
              <NewTaskForm bulkProjectIds={gitProjectIds} />
              {error && <div className="banner banner--warn">No pude refrescar ({error}); mostrando el último estado conocido.</div>}
              {!data ? <p className="empty-mini">Cargando…</p> : (
                <>
                  <div className="section-head" id="sec-proyectos"><h2>Proyectos</h2><span className="meta">{data.projects.length} repos</span></div>
                  <section className="proj-grid">
                    {data.projects.map((p) => <ProjectCard key={p.id} p={p} running={runningByProject.get(p.id) ?? []} />)}
                  </section>
                  <div className="two-col">
                    <div id="sec-atencion">
                      <div className="section-head"><h2>Necesita tu atención</h2><span className="meta">{data.attention.length} ítems</span></div>
                      <AttentionPanel items={data.attention} />
                    </div>
                    <div id="sec-tareas">
                      <InProgressColumn inProgress={data.inProgress} history={data.history} />
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
