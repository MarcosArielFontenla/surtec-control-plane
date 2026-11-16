import { useEffect, useRef, useState } from "react";
import { fetchDispatchOptions, getPortfolioProfiles, openProject, useOverview, useToday } from "./api";
import type { ProjectProfile } from "../../../lib/portfolio-profile";
import type { PortfolioProfileMigrationReport } from "../../../lib/state/portfolio-profiles";
import type { Signal } from "../../../lib/signals/types";
import { Sidebar, type NavItem } from "./components/Sidebar";
import { ProjectCard } from "./components/ProjectCard";
import type { ProjectReadinessNavigationTarget } from "./components/ProjectReadinessPanel";
import { AttentionPanel } from "./components/AttentionPanel";
import { NewTaskForm } from "./components/NewTaskForm";
import { KpiStrip } from "./components/KpiStrip";
import { InProgressColumn } from "./components/InProgressColumn";
import { ProcesosView } from "./views/ProcesosView";
import { IssuesView, type WorkflowFocus } from "./views/IssuesView";
import { ActivityView } from "./views/ActivityView";
import { TodayView } from "./views/TodayView";
import { TaskDetailView } from "./views/TaskDetailView";
import { ProjectDetailView } from "./views/ProjectDetailView";
import { ClientCommitmentsView } from "./views/ClientCommitmentsView";
import { FeedbackMetricsView } from "./views/FeedbackMetricsView";
import { OrganizationView, type OperatingNavigationTarget } from "./views/OrganizationView";
import { useRuns } from "./useRuns";
import { deriveKpis, deriveSummary } from "./derive-kpis";

export function App() {
  const { data, error } = useOverview();
  const today = useToday();
  const { runs } = useRuns();
  const [nav, setNav] = useState<NavItem>("Hoy");
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [workflowFocus, setWorkflowFocus] = useState<WorkflowFocus | null>(null);
  const [objectiveFocus, setObjectiveFocus] = useState<string | null>(null);
  const [returnObjective, setReturnObjective] = useState<string | null>(null);
  const [returnToday, setReturnToday] = useState(false);
  const [readinessReturnProject, setReadinessReturnProject] = useState<{ projectId: string; nav: NavItem } | null>(null);
  const [issueReference, setIssueReference] = useState<{ id: string; projectId: string } | null>(null);
  const [taskReturnProject, setTaskReturnProject] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Record<string, ProjectProfile>>({});
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [profileMigration, setProfileMigration] = useState<PortfolioProfileMigrationReport | null>(null);
  const [taskPrefill, setTaskPrefill] = useState<{ project: string; instructions: string } | null>(null);
  const [navigationWarning, setNavigationWarning] = useState<string | null>(null);
  const navigationSequence = useRef(0);
  const currentProjectSelection = useRef(selectedProject);
  currentProjectSelection.current = selectedProject;
  const renderedNavigationSequence = navigationSequence.current;

  useEffect(() => {
    let active = true;
    getPortfolioProfiles()
      .then(({ profiles: loaded, migration }) => {
        if (!active) return;
        setProfiles(Object.fromEntries(loaded.map((profile) => [profile.project_id, profile])));
        setProfileMigration(migration ?? null);
        setProfilesError(null);
      })
      .catch((reason) => { if (active) setProfilesError((reason as Error).message); })
      .finally(() => { if (active) setProfilesLoaded(true); });
    return () => { active = false; navigationSequence.current++; };
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
  const consumeTaskPrefill = () => setTaskPrefill(null);
  const clearNavigation = () => {
    navigationSequence.current++; setNavigationWarning(null);
    setSelectedTask(null); setSelectedProject(null); setWorkflowFocus(null); setObjectiveFocus(null);
    setIssueReference(null); setTaskReturnProject(null); setTaskPrefill(null);
    setReturnObjective(null); setReturnToday(false);
    setReadinessReturnProject(null);
  };
  const prepareTask = async (signal: Signal) => {
    clearNavigation();
    if (signal.source === "objective" && signal.project_id === "surtec") {
      setNav("SURTEC"); setReturnToday(true); return;
    }
    if (!data?.projects.some(project => project.id === signal.project_id)) {
      setSelectedProject(signal.project_id); setNav("Hoy"); setReturnToday(true); return;
    }
    const sequence = navigationSequence.current;
    try {
      const options = await fetchDispatchOptions();
      if (sequence !== navigationSequence.current) return;
      if (!options.projects.some(project => project.project === signal.project_id)) throw new Error("Project is not available for preparation");
      setTaskPrefill({ project: signal.project_id, instructions: "Review the project and determine the next safe action. Client context is omitted; choose any categories explicitly in the task form." });
      setNav("Overview");
    } catch {
      if (sequence !== navigationSequence.current) return;
      setSelectedProject(signal.project_id); setNav("Hoy"); setReturnToday(true);
      setNavigationWarning("No pude confirmar este proyecto en las opciones actuales; no se preparó un borrador ni se eligió otro proyecto. Revisá su configuración antes de reintentar.");
    }
  };
  const backToToday = () => {
    clearNavigation(); setNav("Hoy");
  };
  const backToObjective = () => {
    const id = returnObjective, todayOrigin = returnToday;
    clearNavigation(); setNav("SURTEC"); setObjectiveFocus(id); setReturnToday(todayOrigin);
  };
  const navigateOperating = (target: OperatingNavigationTarget, source: "organization" | "today" = "organization") => {
    const origin = source === "organization" ? objectiveFocus : null;
    const todayOrigin = source === "today" || returnToday;
    clearNavigation();
    if (target.kind !== "objective") setReturnObjective(origin);
    if (target.kind !== "section" || target.section !== "sessions") setReturnToday(todayOrigin);
    switch (target.kind) {
      case "objective": setNav("SURTEC"); setObjectiveFocus(target.id); break;
      case "project": setNav(source === "today" ? "Hoy" : "SURTEC"); setSelectedProject(target.id); break;
      case "task": setNav(source === "today" ? "Hoy" : "SURTEC"); setSelectedTask(target.id); break;
      case "issue": setNav("Issues"); setIssueReference({ id: target.id, projectId: target.projectId }); break;
      case "workflow": setNav("Issues"); setWorkflowFocus({ workflowId: target.id, issueId: target.issueId, projectId: target.projectId }); break;
      case "section": setNav(target.section === "commitments" ? "Clientes" : "Hoy"); break;
    }
  };
  const openTodayProject = async (id: string) => {
    navigateOperating({ kind: "project", id }, "today");
  };
  const navigateReadiness = (target: ProjectReadinessNavigationTarget) => {
    if (renderedNavigationSequence !== navigationSequence.current || currentProjectSelection.current !== selectedProject) return;
    if (!selectedProjectView || target.projectId !== selectedProjectView.id) {
      setNavigationWarning("La referencia no corresponde al proyecto seleccionado; no se cambió de proyecto ni se preparó trabajo.");
      return;
    }
    const origin = returnObjective, todayOrigin = returnToday, projectOrigin = { projectId: selectedProjectView.id, nav };
    clearNavigation(); setReturnObjective(origin); setReturnToday(todayOrigin); setReadinessReturnProject(projectOrigin); setNav("Issues");
    if (target.kind === "issue") setIssueReference({ id: target.id, projectId: target.projectId });
    if (target.kind === "workflow") setWorkflowFocus({ workflowId: target.id, issueId: target.issueId, projectId: target.projectId });
  };
  const backToReadinessProject = () => {
    if (!readinessReturnProject) return;
    const projectOrigin = readinessReturnProject, origin = returnObjective, todayOrigin = returnToday;
    clearNavigation(); setReturnObjective(origin); setReturnToday(todayOrigin);
    setSelectedProject(projectOrigin.projectId); setNav(projectOrigin.nav);
  };

  return (
    <div className="app">
      <Sidebar active={nav} onSelect={(item) => { clearNavigation(); setNav(item); }} summary={summary} connected={!error && !today.error} />
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
          {navigationWarning && <div className="banner banner--warn" role="alert">{navigationWarning}</div>}
          {returnObjective && <div className="operating-reference panel"><button type="button" className="ibtn" onClick={backToObjective}>Volver al objetivo {returnObjective}</button><p className="organization-meta">Referencia de retorno, no autorización ni prefill de tareas.</p></div>}
          {returnToday && <div className="operating-reference panel"><button type="button" className="ibtn" onClick={backToToday}>Volver a Hoy</button><p className="organization-meta">Retorno a la recomendación; no conserva consentimiento, preview ni autorización.</p></div>}
          {readinessReturnProject && <section className="operating-reference panel" aria-label="Retorno al proyecto"><button type="button" className="ibtn" onClick={backToReadinessProject}>Volver al proyecto {readinessReturnProject.projectId}</button><p className="organization-meta">Referencia de navegación, sin filtro de la lista ni prefill. Para crear un issue, elegí su proyecto explícitamente; preview, consentimiento y autorización siguen en el flujo existente.</p></section>}
          {selectedTask ? (
            <TaskDetailView taskId={selectedTask} onBack={() => { if (nav === "Issues") { setSelectedTask(null); setTaskReturnProject(null); } else if (!taskReturnProject && returnObjective) backToObjective(); else if (!taskReturnProject && returnToday) backToToday(); else { setSelectedTask(null); setSelectedProject(taskReturnProject); setTaskReturnProject(null); } }} onOpenWorkflow={(target) => { const origin = returnObjective, todayOrigin = returnToday, projectOrigin = readinessReturnProject ?? (taskReturnProject ? { projectId: taskReturnProject, nav } : null); clearNavigation(); setReturnObjective(origin); setReturnToday(todayOrigin); if (projectOrigin?.projectId === target.projectId) setReadinessReturnProject(projectOrigin); setWorkflowFocus(target); setNav("Issues"); }} />
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
              onBack={() => returnObjective ? backToObjective() : returnToday ? backToToday() : setSelectedProject(null)}
              onOpenTask={(id) => { setTaskReturnProject(selectedProject); setSelectedProject(null); setSelectedTask(id); }}
              onNavigateReadiness={navigateReadiness}
              onPrepareTask={(project, instructions) => {
                clearNavigation();
                setTaskPrefill({
                  project,
                  instructions: profiles[project]?.kind === "client-product"
                    ? "Review the project and determine the next safe action. Client context is omitted; choose any categories explicitly in the task form."
                    : instructions,
                });
                setNav("Overview");
              }}
              onSessionsChanged={today.refresh}
            />
          ) : selectedProject ? (
            <div className="project-detail-section panel"><p>El proyecto ya no está en el portfolio actual.</p><button type="button" className="ghost-btn" onClick={() => returnObjective ? backToObjective() : returnToday ? backToToday() : setSelectedProject(null)}>Volver al portfolio</button></div>
          ) : view === "Hoy" ? (
            <TodayView data={today.data} error={today.error} onOpenTask={(id) => navigateOperating({ kind: "task", id }, "today")} onRefresh={today.refresh} projects={data?.projects ?? []}
              onOpenProject={openTodayProject} onOpenEditor={(id) => openProject(id, "vscode")}
              onOpenOrganization={() => { clearNavigation(); setNav("SURTEC"); setReturnToday(true); }}
              onNavigate={(target) => navigateOperating(target, "today")}
              onOpenHarness={(id) => navigateOperating({ kind: "project", id }, "today")} onPrepareTask={prepareTask} />
          ) : view === "SURTEC" ? (
            <OrganizationView projects={data?.projects ?? []} profiles={profiles} onNavigate={navigateOperating} focusedObjectiveId={objectiveFocus} onCloseObjective={() => setObjectiveFocus(null)} />
          ) : view === "Clientes" ? (
            <ClientCommitmentsView projects={data?.projects ?? []} />
          ) : view === "Procesos" ? (
            <ProcesosView projectIds={activeProjectIds} />
          ) : view === "Issues" ? (
            <>
              {issueReference && <section className="panel operating-reference" aria-label="Referencia de issue"><h2>Referencia seleccionada</h2><p>Proyecto {issueReference.projectId} · Issue {issueReference.id}</p><p>La lista existente conserva sus tarjetas y acciones protegidas. Si la referencia sigue disponible, podés ir a su tarjeta; no se abre ni inicia un workflow por defecto.</p><a href={`#work-issue-${issueReference.id}`} className="ibtn">Ir a tarjeta {issueReference.id}</a>{!returnToday && !readinessReturnProject && <button className="ibtn" type="button" onClick={() => { clearNavigation(); setNav("SURTEC"); }}>Volver a SURTEC</button>}</section>}
              <IssuesView workflowFocus={workflowFocus} onOpenTask={setSelectedTask} />
            </>
          ) : view === "Actividad" ? (
            <ActivityView />
          ) : view === "Feedback" ? (
            <FeedbackMetricsView />
          ) : (
            <>
              {kpis && <KpiStrip kpis={kpis} />}
              <NewTaskForm bulkProjectIds={gitProjectIds} initialProject={taskPrefill?.project}
                initialInstructions={taskPrefill?.instructions} onPrefillConsumed={consumeTaskPrefill} />
              {error && <div className="banner banner--warn">No pude refrescar ({error}); mostrando el último estado conocido.</div>}
              {profileMigration && <div className="banner banner--warn">Migración local respaldada: {profileMigration.project_count} perfiles; {profileMigration.client_categories_migrated} categorías cliente y {profileMigration.personal_categories_preserved} personales. SHA-256 origen {profileMigration.source_sha256.slice(0, 12)}… · respaldo {profileMigration.backup_id}</div>}
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
