import { useEffect, useState } from "react";
import { getPortfolioProfiles, openProject, useOverview, useToday } from "./api";
import type { ProjectProfile } from "../../../lib/portfolio-profile";
import type { Signal } from "../../../lib/signals/types";
import { Sidebar, type NavItem } from "./components/Sidebar";
import { ProjectCard } from "./components/ProjectCard";
import { AttentionPanel } from "./components/AttentionPanel";
import { NewTaskForm } from "./components/NewTaskForm";
import { KpiStrip } from "./components/KpiStrip";
import { InProgressColumn } from "./components/InProgressColumn";
import { ProcesosView } from "./views/ProcesosView";
import { IssuesView } from "./views/IssuesView";
import { ActivityView } from "./views/ActivityView";
import { TodayView } from "./views/TodayView";
import { TaskDetailView } from "./views/TaskDetailView";
import { ProjectDetailView } from "./views/ProjectDetailView";
import { useRuns } from "./useRuns";
import { deriveKpis, deriveSummary } from "./derive-kpis";

export function App() {
  const { data, error } = useOverview();
  const today = useToday();
  const { runs } = useRuns();
  const [nav, setNav] = useState<NavItem>("Hoy");
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Record<string, ProjectProfile>>({});
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [taskPrefill, setTaskPrefill] = useState<{ project: string; instructions: string } | null>(null);

  useEffect(() => {
    let active = true;
    getPortfolioProfiles()
      .then(({ profiles: loaded }) => {
        if (!active) return;
        setProfiles(Object.fromEntries(loaded.map((profile) => [profile.project_id, profile])));
        setProfilesError(null);
      })
      .catch((reason) => { if (active) setProfilesError((reason as Error).message); })
      .finally(() => { if (active) setProfilesLoaded(true); });
    return () => { active = false; };
  }, []);

  const runningByProject = new Map<string, string[]>();
  for (const r of runs) {
    if (r.status !== "running") continue;
    const label = r.kind === "dev" ? "dev" : "en curso";
    runningByProject.set(r.projectId, [...(runningByProject.get(r.projectId) ?? []), label]);
  }

  const summary = data ? deriveSummary(data) : { total: 0, configured: 0, unconfigured: 0, attention: 0 };
  const kpis = data ? deriveKpis(data, runs) : null;
  const view: NavItem = nav;

  const activeProjectIds = data ? data.projects.filter((p) => p.configured).map((p) => p.id) : [];
  const gitProjectIds = data ? data.projects.filter((p) => p.git?.ok).map((p) => p.id) : [];
  const selectedProjectView = data?.projects.find((project) => project.id === selectedProject) ?? null;
  const prepareTask = (signal: Signal) => {
    setTaskPrefill({ project: signal.project_id, instructions: `${signal.suggested_action}\n\nEvidence: ${signal.reason}` });
    setSelectedTask(null);
    setSelectedProject(null);
    setNav("Overview");
  };
  const consumeTaskPrefill = () => setTaskPrefill(null);

  return (
    <div className="app">
      <Sidebar active={nav} onSelect={(item) => { setNav(item); setSelectedTask(null); setSelectedProject(null); }} summary={summary} connected={!error && !today.error} />
      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <h1>{selectedTask ? "Detalle de tarea" : selectedProject ? "Detalle operativo" : view === "Overview" ? "Estado vivo" : view}</h1>
            <span className="sub">{selectedTask ?? selectedProject ?? `${summary.total} repos · ${data?.inProgress.length ?? 0} tareas activas`}</span>
          </div>
          <span className={`live${error || today.error ? " live--down" : ""}`}>
            <span className="dot" />{error || today.error ? "Sin conexión" : "En vivo"}
          </span>
        </header>

        <div className="wrap">
          {selectedTask ? (
            <TaskDetailView taskId={selectedTask} onBack={() => setSelectedTask(null)} />
          ) : selectedProject && data && selectedProjectView ? (
            <ProjectDetailView
              project={selectedProjectView}
              overview={data}
              today={today.data}
              profile={profiles[selectedProject]}
              profileReady={profilesLoaded && !profilesError}
              profileLoading={!profilesLoaded}
              profileError={profilesError}
              onProfileSaved={(profile) => setProfiles((current) => ({ ...current, [profile.project_id]: profile }))}
              onBack={() => setSelectedProject(null)}
              onOpenTask={(id) => { setSelectedProject(null); setSelectedTask(id); }}
              onPrepareTask={(project, instructions) => {
                setTaskPrefill({ project, instructions });
                setSelectedProject(null);
                setSelectedTask(null);
                setNav("Overview");
              }}
            />
          ) : selectedProject ? (
            <div className="project-detail-section panel"><p>El proyecto ya no está en el portfolio actual.</p><button type="button" className="ghost-btn" onClick={() => setSelectedProject(null)}>Volver al portfolio</button></div>
          ) : view === "Hoy" ? (
            <TodayView data={today.data} error={today.error} onOpenTask={setSelectedTask} onRefresh={today.refresh}
              onOpenProject={(id) => openProject(id, "vscode")} onPrepareTask={prepareTask} />
          ) : view === "Procesos" ? (
            <ProcesosView projectIds={activeProjectIds} />
          ) : view === "Issues" ? (
            <IssuesView />
          ) : view === "Actividad" ? (
            <ActivityView />
          ) : (
            <>
              {kpis && <KpiStrip kpis={kpis} />}
              <NewTaskForm bulkProjectIds={gitProjectIds} initialProject={taskPrefill?.project}
                initialInstructions={taskPrefill?.instructions} onPrefillConsumed={consumeTaskPrefill} />
              {error && <div className="banner banner--warn">No pude refrescar ({error}); mostrando el último estado conocido.</div>}
              {!data ? <p className="empty-mini">Cargando…</p> : (
                <>
                  <div className="section-head"><h2>Proyectos</h2><span className="meta">{data.projects.length} repos</span></div>
                  {profilesError && <div className="banner banner--warn">No pude leer los perfiles operativos locales ({profilesError}); la edición quedó desactivada para proteger los datos existentes.</div>}
                  <section className="proj-grid">
                    {data.projects.map((p) => (
                      <ProjectCard
                        key={p.id}
                        p={p}
                        running={runningByProject.get(p.id) ?? []}
                        onOpenDetail={() => setSelectedProject(p.id)}
                      />
                    ))}
                  </section>
                  <div className="two-col">
                    <div>
                      <div className="section-head"><h2>Necesita tu atención</h2><span className="meta">{data.attention.length} ítems</span></div>
                      <AttentionPanel items={data.attention} onOpenTask={setSelectedTask} />
                    </div>
                    <div>
                      <InProgressColumn inProgress={data.inProgress} history={data.history} onOpenTask={setSelectedTask} />
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
