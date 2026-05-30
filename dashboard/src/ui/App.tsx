import { useState } from "react";
import { useOverview } from "./api";
import { Sidebar, type NavItem } from "./components/Sidebar";
import { ProjectCard } from "./components/ProjectCard";
import { TaskList } from "./components/TaskList";
import { AttentionPanel } from "./components/AttentionPanel";
import { NewTaskForm } from "./components/NewTaskForm";
import { ProcesosView } from "./views/ProcesosView";
import { useRuns } from "./useRuns";
import { BulkSync } from "./components/BulkSync";

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

  return (
    <div className="app-shell">
      <Sidebar active={nav} onSelect={setNav} />
      <div className="app-main">
        <header className="es-top">
          <span className="es-top__title">{nav === "Procesos" ? "Procesos" : "Estado vivo"}</span>
          <span className="es-live">
            <span className={`es-dot ${error ? "es-dot--danger" : "es-dot--ok"}`} />
            <span>{error ? "sin conexión" : "en vivo"}</span>
          </span>
        </header>
        <main className="app-content">
          {nav === "Procesos" ? (
            <ProcesosView projectIds={data ? data.projects.filter((p) => p.configured).map((p) => p.id) : []} />
          ) : (
            <>
              <NewTaskForm />
              {error && (
                <div className="es-banner es-banner--warn">
                  No pude refrescar ({error}); mostrando el último estado conocido.
                </div>
              )}
              {!data ? (
                <p className="es-empty">Cargando…</p>
              ) : (
                <>
                  <BulkSync projectIds={data.projects.filter((p) => p.git?.ok).map((p) => p.id)} />
                  <section>
                    <h4 className="es-section__title">Proyectos</h4>
                    <div className="es-cards">
                      {data.projects.map((p) => (
                        <ProjectCard key={p.id} p={p} running={runningByProject.get(p.id) ?? []} />
                      ))}
                    </div>
                  </section>
                  <div className="es-cols">
                    <TaskList title="En curso" tasks={data.inProgress} />
                    <AttentionPanel items={data.attention} />
                  </div>
                  <TaskList title="Historial" tasks={data.history} />
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
