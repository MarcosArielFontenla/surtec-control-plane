import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Code2, ExternalLink, Folder, RotateCw, Send } from "lucide-react";
import type { ProjectIntegrationsSnapshot, IntegrationHealth } from "../../../../lib/integrations/types";
import type { ProjectProfile } from "../../../../lib/portfolio-profile";
import type { ActivityFeed, ActivityItem, OverviewModel, ProjectView, TaskView, TodayModel } from "../../../../lib/state/types";
import type { Signal, SignalFeed } from "../../../../lib/signals/types";
import { githubWebUrl } from "../../../../lib/github-url";
import { getActivity, getProjectIntegrations, getSignals, openProject } from "../api";
import { ProjectNotes } from "../components/ProjectNotes";
import { ProjectProfileEditor } from "../components/ProjectProfileEditor";
import { relativeTime } from "../relative-time";

const HEALTH_LABEL: Record<IntegrationHealth, string> = {
  ok: "Operativo",
  degraded: "Degradado",
  down: "Caído",
  unknown: "Desconocido",
  unconfigured: "Sin configurar",
};

function ProviderCard({
  title,
  provider,
  configured,
  health,
  observedAt,
  error,
  href,
  children,
}: {
  title: string;
  provider: string;
  configured: boolean;
  health: IntegrationHealth;
  observedAt: string;
  error?: string;
  href?: string | null;
  children?: React.ReactNode;
}) {
  const state = configured ? health : "unconfigured";
  return (
    <article className={`project-integration project-integration--${state}`}>
      <div className="project-integration__top">
        <div><span className="project-integration__provider">{provider}</span><h3>{title}</h3></div>
        <span className={`project-integration__status project-integration__status--${state}`}><i />{HEALTH_LABEL[state]}</span>
      </div>
      <p className="project-integration__freshness" title={observedAt}>Observado {relativeTime(observedAt)}</p>
      {children && <div className="project-integration__body">{children}</div>}
      {error && <p className="project-integration__error">{error}</p>}
      {href && <a className="project-integration__link" href={href} target="_blank" rel="noreferrer">Abrir proveedor <ExternalLink size={13} /></a>}
    </article>
  );
}

function IntegrationGrid({ snapshot, project }: { snapshot: ProjectIntegrationsSnapshot; project: ProjectView }) {
  const githubUrl = githubWebUrl(project.repo);
  const git = snapshot.source_control;
  const github = git.remote;
  const ci = snapshot.ci;
  const ciUrl = githubUrl && ci.run_id && /^\d{1,24}$/.test(ci.run_id) ? `${githubUrl}/actions/runs/${ci.run_id}` : null;

  return (
    <div className="project-integration-grid">
      <ProviderCard title="Control de código" provider={git.provider} configured={git.configured} health={git.health}
        observedAt={snapshot.observed_at} error={git.error} href={githubUrl}>
        {git.configured && <dl className="project-integration__facts">
          <div><dt>Branch</dt><dd>{git.branch ?? "Detached"}</dd></div>
          <div><dt>Árbol de trabajo</dt><dd>{git.dirty == null ? "Sin dato" : git.dirty ? `${git.uncommitted ?? 0} cambios sin commit` : "Limpio"}</dd></div>
          <div><dt>Sincronización</dt><dd>↑{git.ahead ?? "—"} · ↓{git.behind ?? "—"}</dd></div>
        </dl>}
      </ProviderCard>

      <ProviderCard title="Pull requests e issues" provider={github.provider} configured={github.configured} health={github.health}
        observedAt={snapshot.observed_at} error={github.error} href={githubUrl ? `${githubUrl}/issues` : null}>
        {github.configured && <>
          <p>{github.pull_requests ?? "—"} PR abiertas · {github.issues ?? "—"} issues abiertas</p>
          {github.waiting_pull_requests && github.waiting_pull_requests.length > 0 && (
            <ul className="project-evidence-list">
              {github.waiting_pull_requests.slice(0, 5).map((item) => (
                <li key={item.number}>
                  {githubUrl ? <a href={`${githubUrl}/pull/${item.number}`} target="_blank" rel="noreferrer">PR #{item.number}</a> : `PR #${item.number}`}
                  <span>{item.review_decision === "CHANGES_REQUESTED" ? "Cambios solicitados" : "Revisión requerida"}</span>
                </li>
              ))}
            </ul>
          )}
        </>}
      </ProviderCard>

      <ProviderCard title="Integración continua" provider={ci.provider} configured={ci.configured} health={ci.health}
        observedAt={snapshot.observed_at} error={ci.error} href={ciUrl}>
        {ci.configured && <>
          <p>{ci.status ?? "Sin estado"}{ci.branch ? ` · ${ci.branch}` : ""}</p>
          {ci.run_updated_at && <p className="project-integration__run-time">Run actualizado {relativeTime(ci.run_updated_at)}</p>}
        </>}
      </ProviderCard>

      <ProviderCard title="Dependencias" provider={snapshot.dependencies.provider} configured={snapshot.dependencies.configured}
        health={snapshot.dependencies.health} observedAt={snapshot.dependencies.observed_at} error={snapshot.dependencies.error}>
        {snapshot.dependencies.configured && <p>{snapshot.dependencies.outdated == null ? "Sin conteo disponible" : snapshot.dependencies.outdated === 0 ? "Al día" : `${snapshot.dependencies.outdated} desactualizadas`}</p>}
      </ProviderCard>

      {snapshot.deployments.map((deployment) => (
        <ProviderCard key={deployment.provider} title={deployment.provider === "http-health" ? "Health check" : "Deployment"}
          provider={deployment.provider} configured={deployment.configured} health={deployment.health}
          observedAt={deployment.observed_at} error={deployment.error} href={deployment.url}>
          {deployment.configured && <p>{deployment.status ?? "Sin estado"}{deployment.http_status ? ` · HTTP ${deployment.http_status}` : ""}{deployment.latency_ms == null ? "" : ` · ${deployment.latency_ms} ms`}</p>}
        </ProviderCard>
      ))}
    </div>
  );
}

function taskRows(overview: OverviewModel, today: TodayModel | null, projectId: string) {
  const byId = new Map<string, TaskView>();
  for (const task of [...overview.inProgress, ...overview.history, ...(today?.completed ?? []), ...(today?.failed ?? []), ...(today?.cancelled ?? [])]) {
    if (task.project !== projectId) continue;
    const current = byId.get(task.id);
    if (!current || task.updated_at > current.updated_at) byId.set(task.id, task);
  }
  return [...byId.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function TaskList({ title, tasks, onOpenTask }: { title: string; tasks: TaskView[]; onOpenTask: (id: string) => void }) {
  return (
    <section className="project-detail-section panel">
      <div className="section-head"><h2>{title}</h2><span className="meta">{tasks.length}</span></div>
      {tasks.length === 0 ? <p className="empty-mini">Sin tareas en esta sección.</p> : tasks.map((task) => (
        <button type="button" className="project-detail-row" key={task.id} onClick={() => onOpenTask(task.id)}>
          <span><b>{task.title}</b><small>{task.id} · {task.agent}</small></span>
          <span className="project-detail-row__meta">{task.lifecycle === "running" ? "En curso" : task.outcome ?? "En espera"} · {relativeTime(task.updated_at)}</span>
        </button>
      ))}
    </section>
  );
}

function SignalSection({ title, signals }: { title: string; signals: Signal[] }) {
  return (
    <section className="project-detail-section panel">
      <div className="section-head"><h2>{title}</h2><span className="meta">{signals.length}</span></div>
      {signals.length === 0 ? <p className="empty-mini">Sin señales.</p> : signals.slice(0, 10).map((signal) => (
        <article className="project-detail-row project-detail-row--static" key={signal.id}>
          <span><b>{signal.title}</b><small>{signal.source} · {signal.severity} · {relativeTime(signal.evidence_at)}</small></span>
          <span className={`project-signal-state project-signal-state--${signal.state}`}>{signal.state === "acknowledged" ? "Reconocida" : signal.state === "snoozed" ? "Pospuesta" : signal.state === "resolved" ? "Resuelta" : "Abierta"}</span>
        </article>
      ))}
    </section>
  );
}

function ActivityRows({ items, onOpenTask }: { items: ActivityItem[]; onOpenTask: (id: string) => void }) {
  return (
    <section className="project-detail-section panel">
      <div className="section-head"><h2>Actividad reciente</h2><span className="meta">{items.length}</span></div>
      {items.length === 0 ? <p className="empty-mini">Sin actividad reciente.</p> : items.slice(0, 10).map((item) => (
        item.kind === "task" ? (
          <button type="button" className="project-detail-row" key={`${item.kind}-${item.taskId}`} onClick={() => onOpenTask(item.taskId)}>
            <span><b>{item.title}</b><small>Tarea {item.state} · {item.agent}</small></span><span className="project-detail-row__meta">{relativeTime(item.at)}</span>
          </button>
        ) : (
          <article className="project-detail-row project-detail-row--static" key={`${item.kind}-${item.hash}`}>
            <span><b>{item.subject}</b><small>Commit {item.hash} · {item.author}</small></span><span className="project-detail-row__meta">{relativeTime(item.at)}</span>
          </article>
        )
      ))}
    </section>
  );
}

export function ProjectDetailView({
  project,
  overview,
  today,
  profile,
  profileReady,
  profileLoading,
  profileError,
  onProfileSaved,
  onBack,
  onOpenTask,
  onPrepareTask,
}: {
  project: ProjectView;
  overview: OverviewModel;
  today: TodayModel | null;
  profile?: ProjectProfile;
  profileReady: boolean;
  profileLoading: boolean;
  profileError?: string | null;
  onProfileSaved: (profile: ProjectProfile) => void;
  onBack: () => void;
  onOpenTask: (id: string) => void;
  onPrepareTask: (projectId: string, instructions: string) => void;
}) {
  const [integrations, setIntegrations] = useState<ProjectIntegrationsSnapshot | null>(null);
  const [integrationsError, setIntegrationsError] = useState<string | null>(null);
  const [integrationsLoading, setIntegrationsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [signalFeed, setSignalFeed] = useState<SignalFeed | null>(null);
  const [signalError, setSignalError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityFeed | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const id = project.id;

  useEffect(() => {
    let active = true;
    setIntegrationsLoading(true);
    setIntegrationsError(null);
    getProjectIntegrations(id)
      .then((value) => { if (active) setIntegrations(value); })
      .catch((reason) => { if (active) setIntegrationsError((reason as Error).message); })
      .finally(() => { if (active) setIntegrationsLoading(false); });
    getSignals()
      .then((value) => { if (active) { setSignalFeed(value); setSignalError(null); } })
      .catch((reason) => { if (active) setSignalError((reason as Error).message); });
    getActivity()
      .then((value) => { if (active) { setActivity(value); setActivityError(null); } })
      .catch((reason) => { if (active) setActivityError((reason as Error).message); });
    return () => { active = false; };
  }, [id]);

  const refreshIntegrations = async () => {
    setRefreshing(true);
    setIntegrationsError(null);
    try { setIntegrations(await getProjectIntegrations(id, true)); }
    catch (reason) { setIntegrationsError((reason as Error).message); }
    finally { setRefreshing(false); }
  };
  const runOpen = async (target: "vscode" | "folder") => {
    setOpenError(null);
    try { await openProject(id, target); } catch (reason) { setOpenError((reason as Error).message); }
  };

  const tasks = useMemo(() => taskRows(overview, today, id), [overview, today, id]);
  const activeTasks = tasks.filter((task) => task.lifecycle !== "finished");
  const recentTasks = tasks.filter((task) => task.lifecycle === "finished").slice(0, 10);
  const projectSignals = useMemo(() => (signalFeed?.signals ?? []).filter((signal) => signal.project_id === id), [signalFeed, id]);
  const openSignals = projectSignals.filter((signal) => signal.state === "open" || signal.state === "acknowledged");
  const snoozedSignals = projectSignals.filter((signal) => signal.state === "snoozed");
  const resolvedSignals = projectSignals.filter((signal) => signal.state === "resolved");
  const projectActivity = useMemo(() => (activity?.items ?? []).filter((item) => item.project === id), [activity, id]);
  const sessionState = today?.portfolio.sessions;
  const instructions = profile?.next_action ?? profile?.current_goal ?? `Review the current operating state of ${id} and propose a safe next step.`;

  return (
    <div className="project-detail">
      <div className="project-detail-header">
        <button type="button" className="ghost-btn" onClick={onBack}><ArrowLeft size={15} /> Volver al portfolio</button>
        <div className="project-detail-heading">
          <div><span className="b-label">Detalle operativo del proyecto</span><h2>{id}</h2></div>
          <div className="project-detail-actions">
            <button type="button" className="ibtn" onClick={() => void runOpen("vscode")}><Code2 size={14} /> Abrir código</button>
            <button type="button" className="ibtn" onClick={() => void runOpen("folder")}><Folder size={14} /> Carpeta</button>
            <button type="button" className="ibtn primary" onClick={() => onPrepareTask(id, instructions)}><Send size={14} /> Preparar tarea</button>
          </div>
        </div>
      </div>
      {openError && <div className="banner banner--warn" role="alert">No pude abrir el proyecto: {openError}</div>}

      <section className="project-detail-section panel">
        <div className="section-head"><h2>Perfil y próximo paso</h2><span className="meta">{profile?.kind === "client" ? "Cliente" : profile ? "Personal" : "Sin perfil"}</span></div>
        {profileError ? <div className="banner banner--warn">No pude leer el perfil operativo ({profileError}); la edición quedó desactivada para proteger el estado local.</div>
          : !profile && <p className="empty-mini">El proyecto funciona sin perfil local. Podés registrar su objetivo y próxima acción.</p>}
        <ProjectProfileEditor projectId={id} profile={profile} ready={profileReady} loading={profileLoading} onSaved={onProfileSaved} />
      </section>

      <section className="project-detail-section">
        <div className="section-head project-integrations-heading">
          <div><h2>Integraciones</h2><p>{integrations ? `Snapshot ${integrations.schema_version} · observado ${relativeTime(integrations.observed_at)}` : "Estado independiente por proveedor"}</p></div>
          <button type="button" className="ibtn" disabled={refreshing || integrationsLoading} onClick={() => void refreshIntegrations()}><RotateCw size={14} /> {refreshing ? "Actualizando…" : "Actualizar"}</button>
        </div>
        {integrationsError && <div className="banner banner--warn" role="alert">No pude actualizar las integraciones ({integrationsError}); el resto del detalle sigue disponible.</div>}
        {integrationsLoading && !integrations && <p className="empty-mini">Leyendo snapshot de integraciones…</p>}
        {integrations && <IntegrationGrid snapshot={integrations} project={project} />}
      </section>

      <section className="project-detail-section panel">
        <div className="section-head"><h2>Sesiones de trabajo</h2><span className="meta">{sessionState?.available ? "Disponible" : "Pendiente"}</span></div>
        <p className="empty-mini">{sessionState?.unavailable_reason ?? "Las sesiones persistidas se incorporarán en la Fase G."}</p>
      </section>

      <div className="project-detail-grid">
        <TaskList title="Tareas activas" tasks={activeTasks} onOpenTask={onOpenTask} />
        <TaskList title="Tareas recientes" tasks={recentTasks} onOpenTask={onOpenTask} />
        <SignalSection title="Señales abiertas" signals={openSignals} />
        <SignalSection title="Señales pospuestas" signals={snoozedSignals} />
        <SignalSection title="Señales resueltas" signals={resolvedSignals} />
        <section className="project-detail-section panel">
          <div className="section-head"><h2>Notas locales</h2><span className="meta">Solo este dispositivo</span></div>
          <ProjectNotes projectId={id} expanded />
        </section>
        <ActivityRows items={projectActivity} onOpenTask={onOpenTask} />
      </div>
      {signalError && <div className="banner banner--warn">Las señales de este proyecto no están disponibles ({signalError}).</div>}
      {activityError && <div className="banner banner--warn">La actividad reciente no está disponible ({activityError}).</div>}
    </div>
  );
}
