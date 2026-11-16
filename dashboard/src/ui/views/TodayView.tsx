import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Clock3, Pin, RotateCw, Send, ShieldCheck, X } from "lucide-react";
import type { Signal, SignalAction } from "../../../../lib/signals/types";
import type { TaskView, TodayActivity, TodayModel, ProjectView } from "../../../../lib/state/types";
import type { OperatingRow, OperatingView } from "../../../../lib/operating-views";
import { isSafeIdentifier } from "../../../../lib/security/identifiers";
import { getContextRoles, getOperatingProject, postSignalAction, type ContextRole } from "../api";
import { AttentionPanel } from "../components/AttentionPanel";
import { InProgressColumn } from "../components/InProgressColumn";
import { WorkSessionsPanel } from "../components/WorkSessionsPanel";
import { RoutinePanel } from "../components/RoutinePanel";
import { relativeTime } from "../relative-time";
import { contextDisplayText as safe } from "../components/ContextPreview";
import type { OperatingNavigationTarget } from "./OrganizationView";

function publicId(value: unknown): string | null {
  return isSafeIdentifier(value) ? value : null;
}

function RecommendationLineage({ signal, onNavigate }: { signal: Signal; onNavigate?: (target: OperatingNavigationTarget) => void }) {
  const taskId = publicId(signal.evidence.task_id);
  const objectiveId = signal.source === "objective" ? publicId(signal.evidence.objective_id) : null;
  const primaryId = publicId(signal.evidence.primary_objective_id);
  const key = JSON.stringify([signal.id, signal.project_id, signal.source, signal.type, signal.evidence_at, signal.observed_at, taskId]);
  const sequence = useRef(0);
  const [snapshot, setSnapshot] = useState<{ key: string; pending?: boolean; view?: OperatingView; roles?: ContextRole[]; warning?: string } | null>(null);
  useEffect(() => { sequence.current++; setSnapshot(null); return () => { sequence.current++; }; }, [key]);
  const current = snapshot?.key === key ? snapshot : null;
  async function consult() {
    const request = ++sequence.current;
    setSnapshot({ key, pending: true });
    const [viewResult, rolesResult] = await Promise.allSettled([getOperatingProject(signal.project_id, { page_size: 20 }), getContextRoles(signal.project_id)]);
    if (request !== sequence.current) return;
    const view = viewResult.status === "fulfilled" && viewResult.value?.schema_version === 1 && viewResult.value.view === "project"
      && viewResult.value.focus_id === signal.project_id && viewResult.value.focus_status === "available" && viewResult.value.execution_authority === "none" ? viewResult.value : undefined;
    const roles = rolesResult.status === "fulfilled" && Array.isArray(rolesResult.value?.roles)
      && rolesResult.value.roles.every(role => role && typeof role === "object" && publicId(role.id)
        && typeof role.display_name === "string" && typeof role.responsibility === "string"
        && ["read-only", "workspace-write"].includes(role.sandbox_ceiling)
        && Array.isArray(role.agents) && role.agents.every(id => publicId(id))) ? rolesResult.value.roles : undefined;
    setSnapshot({ key, view, roles, warning: !view || !roles ? "Una fuente de linaje o perfiles no pudo confirmarse; las demás referencias siguen disponibles." : undefined });
  }
  const project = current?.view?.sections.find(section => section.kind === "projects" && section.source.availability === "available")?.rows.find(row => row.id === signal.project_id);
  const executions = current?.view?.sections.find(section => section.kind === "executions");
  const recordedTask = executions?.source.availability === "available" && taskId
    ? executions.rows.find(row => row.id === taskId && row.project_id === signal.project_id && row.lineage.project_id === signal.project_id) : undefined;
  const issueId = recordedTask && !recordedTask.lineage.gaps.some(gap => gap === "issue-unavailable" || gap === "cross-project")
    && recordedTask.issue_id === recordedTask.lineage.issue_id ? publicId(recordedTask.issue_id) : null;
  const workflows = current?.view?.sections.find(section => section.kind === "workflows");
  const recordedWorkflows = workflows?.source.availability === "available" && issueId
    ? workflows.rows.filter(row => row.issue_id === issueId && row.lineage.issue_id === issueId && row.project_id === signal.project_id && row.lineage.project_id === signal.project_id && !row.lineage.gaps.includes("cross-project")) : [];
  const navigate = (target: OperatingNavigationTarget) => onNavigate?.(target);
  const objective = (id: string, label: string) => <>{label}: {id} {onNavigate && <button type="button" className="ghost-btn" onClick={() => navigate({ kind: "objective", id })}>Ver objetivo {id}</button>}</>;
  const recordedRole = (row: OperatingRow) => row.role_id ? `${safe(row.role_id)} · referencia registrada, no permiso actual` : "Perfil no informado en el registro";
  return <section aria-label={`Linaje de ${signal.id}`} style={{ overflowWrap: "anywhere", minWidth: 0 }}>
    <p className="today-signal-objective">{objectiveId ? objective(objectiveId, "Objetivo de esta señal") : "Objetivo propio de la señal: no informado."}</p>
    {primaryId && <p>{objective(primaryId, "Contexto estratégico del proyecto")} · no atribuye el issue a ese objetivo.</p>}
    {!objectiveId && !primaryId && <p>{signal.project_kind === "personal" || signal.project_kind === "experiment" ? "El objetivo es opcional para trabajo personal; su ausencia en esta señal no prueba una desalineación intencional." : "Vínculo estratégico no informado por esta señal."}</p>}
    <p>Proyecto: {safe(signal.project_id)} · Señal: {safe(signal.id)} · {signal.source} / {safe(signal.type)}</p>
    <p>Issue local: {issueId ? <>{issueId} {onNavigate && <button type="button" className="ghost-btn" onClick={() => navigate({ kind: "issue", id: issueId, projectId: signal.project_id })}>Ver issue {issueId}</button>}</> : "no confirmado; no se deduce de un número de GitHub."}</p>
    {signal.source === "issue" && Number.isSafeInteger(signal.evidence.issue_number) && Number(signal.evidence.issue_number) > 0 && <p>Referencia externa: issue GitHub #{Number(signal.evidence.issue_number)}; no es un issue local ni autoriza su scope.</p>}
    <p>Rol / workflow de esta señal: no informados por el feed. Las referencias consultadas y los perfiles disponibles no son un grant de ejecución.</p>
    <details><summary>Linaje y perfiles · consultar evidencia</summary>
      <p>Consulta explícita de snapshots locales y perfiles registrados. No inicia preview, workflow, tarea ni editor; no refresca proveedores.</p>
      <button type="button" className="ibtn" disabled={current?.pending} onClick={() => void consult()}>{current?.pending ? "Consultando linaje…" : "Consultar linaje y perfiles"}</button>
      {current?.warning && <p role="status">{current.warning}</p>}
      {current?.view && <>
        <p>Alineación del proyecto consultado: {project?.lineage.alignment ?? "no disponible en esta página"}. {project?.lineage.alignment === "intentionally-unaligned" && "Independencia personal intencional según el snapshot canónico disponible; no exige objetivo ni cliente."}</p>
        {project?.lineage.objective_ids.map(id => <p key={id}>{objective(id, "Ancestría del proyecto consultado")}</p>)}
        <p>Esta consulta no reconcilia señales: el adapter de señales de la vista operativa no está disponible. Solo se unen IDs exactos de proyecto/tarea/issue; no se elige otro registro cuando falta uno.</p>
        <p>Perfil de la ejecución referenciada: {recordedTask ? recordedRole(recordedTask) : "sin ejecución coincidente en esta página"}.</p>
        {recordedWorkflows.length ? recordedWorkflows.map(row => <p key={row.id}>Workflow registrado {row.id} · template {row.workflow_template_id ?? "no informado"} · {recordedRole(row)} · estado {row.state ?? "no informado"}. {onNavigate && <button type="button" className="ghost-btn" onClick={() => navigate({ kind: "workflow", id: row.id, issueId: issueId!, projectId: signal.project_id })}>Ver workflow {row.id}</button>}</p>)
          : <p>Sin workflow exacto disponible en esta página; no se sugiere uno desde el título o la próxima acción.</p>}
        {current.view.sections.filter(section => ["projects", "executions", "workflows"].includes(section.kind)).map(section => <p key={section.kind}>{section.kind}: {section.source.availability} · {section.source.freshness} · cobertura {section.coverage} · observado {section.source.observed_at ?? "desconocido"}{section.has_more ? " · hay más registros fuera de esta página" : ""}.</p>)}
      </>}
      {current?.roles && <section aria-label={`Perfiles registrados de ${signal.id}`}>
        <h4>Perfiles registrados para revisar en preview</h4>
        {current.roles.length === 0 ? <p>Sin perfiles disponibles en esta lectura; no se inventa un agente alternativo.</p> : <ul>{current.roles.slice(0, 20).map(role => <li key={role.id}>{safe(role.display_name)} · {safe(role.id)} · {role.sandbox_ceiling} · agentes {role.agents.slice(0, 20).map(safe).join(", ")}</li>)}</ul>}
        {current.roles.length > 20 && <p>Se muestran 20 de {current.roles.length} perfiles registrados.</p>}
        <p>Este listado no confirma el task kind, scope, consentimiento, presupuesto ni sandbox efectivo. La autorización y elección se verifican en el formulario/preview existente, no aquí.</p>
      </section>}
    </details>
  </section>;
}

const TIER_LABELS: Record<Signal["ranking"]["tier"], string> = {
  "production-failure": "Producción",
  "client-commitment": "Compromiso cliente",
  "blocked-work": "Trabajo bloqueado",
  "imminent-deadline": "Fecha próxima",
  "unfinished-work": "Continuar trabajo",
  maintenance: "Mantenimiento",
  hygiene: "Higiene de perfil",
};

const SEVERITY_LABELS: Record<Signal["severity"], string> = {
  critical: "Crítica",
  warning: "Atención",
  info: "Oportunidad",
};
const PROJECT_CATEGORY_LABEL: Record<NonNullable<Signal["project_kind"]>, string> = {
  personal: "Personal", "internal-tool": "Herramienta interna", "surtec-product": "Producto SURTEC",
  "client-product": "Producto de cliente", experiment: "Experimento", template: "Plantilla",
};

function OutcomeSection({ title, tasks, onOpenTask }: { title: string; tasks: TaskView[]; onOpenTask: (id: string) => void }) {
  return (
    <section className="today-section panel">
      <div className="section-head"><h2>{title}</h2><span className="meta">{tasks.length}</span></div>
      {tasks.length === 0 ? <p className="empty-mini">Sin actividad.</p> : tasks.map((task) => (
        <button type="button" className="today-task" key={task.id} onClick={() => onOpenTask(task.id)}>
          <span className="hid">{task.id}</span>
          <span className="today-task-copy"><b>{task.title}</b><small>{task.project} · {task.agent}</small></span>
          <span className={`st ${task.outcome === "completed" || task.outcome === "partial" ? "completed" : "failed"}`}>{task.outcome}</span>
        </button>
      ))}
    </section>
  );
}

function ActivityRows({ items, onOpenTask }: { items: TodayActivity[]; onOpenTask: (id: string) => void }) {
  if (items.length === 0) return <p className="empty-mini">Sin eventos.</p>;
  return <>{items.map(({ task, event }) => (
    <button type="button" className="today-task" key={event.event_id} onClick={() => onOpenTask(task.id)}>
      <span className="hid">{task.id}</span>
      <span className="today-task-copy"><b>{event.type}</b><small>{task.project} · intento {event.attempt ?? "—"}</small></span>
      <span className="feed-when">{relativeTime(event.at)}</span>
    </button>
  ))}</>;
}

function SignalCard({
  signal,
  pinned,
  busy,
  onAction,
  onOpenTask,
  onOpenProject,
  onPrepareTask,
  onOpenHarness,
  onOpenEditor,
  onNavigate,
  onOpenOrganization,
}: {
  signal: Signal;
  pinned: boolean;
  busy: boolean;
  onAction: (signal: Signal, action: SignalAction) => void;
  onOpenTask: (id: string) => void;
  onOpenProject: (id: string) => void;
  onPrepareTask: (signal: Signal) => void;
  onOpenHarness?: (id: string) => void;
  onOpenEditor?: (id: string) => void;
  onNavigate?: (target: OperatingNavigationTarget) => void;
  onOpenOrganization?: () => void;
}) {
  const taskId = publicId(signal.evidence.task_id);
  const objectiveId = signal.source === "objective" ? publicId(signal.evidence.objective_id) : null;
  const category = signal.project_id === "surtec" && signal.source === "objective" ? "Objetivo SURTEC"
    : signal.project_kind ? PROJECT_CATEGORY_LABEL[signal.project_kind] : "Proyecto";
  const stateLabel = signal.state === "acknowledged" ? "Reconocida" : signal.state === "snoozed" ? "Pospuesta" : signal.state === "resolved" ? "Resuelta" : null;
  return (
    <article aria-label={`Recomendación ${signal.id}`} className={`today-signal panel${signal.severity === "critical" ? " today-signal--critical" : ""}`} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      <div className="today-signal-topline">
        <span className={`signal-impact signal-impact--${signal.severity}`}>{SEVERITY_LABELS[signal.severity]}</span>
        <span className="today-signal-category">{category}</span>
        {stateLabel && <span className="today-signal-state">{stateLabel}</span>}
        {pinned && <span className="today-pinned"><Pin size={12} /> Fijada hoy</span>}
      </div>
      <p className="today-signal-project">{signal.project_id}</p>
      <h3>{safe(signal.title)}</h3>
      <p className="today-signal-reason">{safe(signal.reason)}</p>
      <RecommendationLineage signal={signal} onNavigate={onNavigate} />
      <p className="today-signal-next"><b>Siguiente paso sugerido, no autorizado</b> {safe(signal.suggested_action)}</p>
      <div className="today-signal-evidence">
        <span>Fecha de referencia de la señal: <time dateTime={signal.evidence_at}>{signal.evidence_at}</time></span>
        <span>Señal observada: <time dateTime={signal.observed_at}>{signal.observed_at}</time></span>
        <span>Prioridad #{signal.ranking.order} · {TIER_LABELS[signal.ranking.tier]}</span>
      </div>
      <div className="today-signal-actions" aria-label={`Acciones para ${signal.project_id}`}>
        <button type="button" disabled={busy} onClick={() => onAction(signal, { action: "acknowledge" })} title="Reconocer">
          <Check size={13} /> Reconocer
        </button>
        <button type="button" disabled={busy} onClick={() => onAction(signal, { action: "pin-for-today" })} title="Fijar para hoy">
          <Pin size={13} /> Fijar
        </button>
        <button type="button" disabled={busy} onClick={() => onAction(signal, { action: "snooze", until: new Date(Date.now() + 60 * 60 * 1000).toISOString() })} title="Posponer una hora">
          <Clock3 size={13} /> 1 h
        </button>
        <button type="button" disabled={busy} onClick={() => onAction(signal, { action: "resolve" })} title="Resolver">
          <ShieldCheck size={13} /> Resolver
        </button>
        <button type="button" disabled={busy} onClick={() => onAction(signal, { action: "dismiss" })} title="Descartar esta señal">
          <X size={13} /> Descartar
        </button>
      </div>
      <div className="today-signal-links">
        {typeof taskId === "string" && <button type="button" className="ghost-btn" onClick={() => onOpenTask(taskId)}>Ver tarea <ArrowUpRight size={13} /></button>}
        <button type="button" className="ghost-btn" onClick={() => {
          if (signal.source === "harness") onOpenHarness?.(signal.project_id);
          else if (signal.project_id === "surtec" && signal.source === "objective" && objectiveId && onNavigate) onNavigate({ kind: "objective", id: objectiveId });
          else if (signal.project_id === "surtec" && signal.source === "objective" && onOpenOrganization) onOpenOrganization();
          else onOpenProject(signal.project_id);
        }}>{signal.source === "harness" ? "Ver Harness" : signal.project_id === "surtec" && signal.source === "objective" ? "Abrir SURTEC" : "Abrir proyecto"} <ArrowUpRight size={13} /></button>
        {onOpenEditor && !(signal.project_id === "surtec" && signal.source === "objective") && <button type="button" className="ghost-btn" onClick={() => onOpenEditor(signal.project_id)}>Abrir en VS Code <ArrowUpRight size={13} /></button>}
        {signal.source !== "harness" && !(signal.project_id === "surtec" && signal.source === "objective") && <button type="button" className="ghost-btn" onClick={() => onPrepareTask(signal)}><Send size={13} /> Preparar tarea</button>}
      </div>
      <p className="work-issue-note">Preparar tarea solo completa un borrador genérico: no copia motivo, acción sugerida, feedback ni notas privadas. Elegí perfil y categorías explícitamente y revisá el preview antes de cualquier ejecución.</p>
      {busy && <span className="today-signal-busy" role="status">Guardando acción…</span>}
    </article>
  );
}

function SignalSection({
  title,
  signals,
  pinnedIds,
  empty,
  busySignal,
  onAction,
  onOpenTask,
  onOpenProject,
  onPrepareTask,
  onOpenHarness,
  onOpenEditor,
  onNavigate,
  onOpenOrganization,
}: {
  title: string;
  signals: Signal[];
  pinnedIds: string[];
  empty: string;
  busySignal: string | null;
  onAction: (signal: Signal, action: SignalAction) => void;
  onOpenTask: (id: string) => void;
  onOpenProject: (id: string) => void;
  onPrepareTask: (signal: Signal) => void;
  onOpenHarness?: (id: string) => void;
  onOpenEditor?: (id: string) => void;
  onNavigate?: (target: OperatingNavigationTarget) => void;
  onOpenOrganization?: () => void;
}) {
  return (
    <section className="today-portfolio-section">
      {title && <div className="section-head"><h2>{title}</h2><span className="meta">{signals.length}</span></div>}
      {signals.length === 0 ? <p className="empty-mini">{empty}</p> : (
        <div className="today-signal-grid">
          {signals.map((signal) => (
            <SignalCard key={signal.id} signal={signal} pinned={pinnedIds.includes(signal.id)} busy={busySignal === signal.id}
              onAction={onAction} onOpenTask={onOpenTask} onOpenProject={onOpenProject} onPrepareTask={onPrepareTask} onOpenHarness={onOpenHarness} onOpenEditor={onOpenEditor} onNavigate={onNavigate} onOpenOrganization={onOpenOrganization} />
          ))}
        </div>
      )}
    </section>
  );
}

export function TodayView({
  data,
  error,
  onOpenTask,
  onOpenProject,
  onPrepareTask,
  onOpenHarness,
  onOpenEditor,
  onNavigate,
  onOpenOrganization,
  onRefresh,
  projects = [],
}: {
  data: TodayModel | null;
  error: string | null;
  onOpenTask: (id: string) => void;
  onOpenProject: (id: string) => Promise<void>;
  onPrepareTask: (signal: Signal) => void;
  onOpenHarness?: (id: string) => void;
  onOpenEditor?: (id: string) => Promise<void>;
  onNavigate?: (target: OperatingNavigationTarget) => void;
  onOpenOrganization?: () => void;
  onRefresh: () => Promise<TodayModel>;
  projects?: ProjectView[];
}) {
  const [busySignal, setBusySignal] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!data) return error ? <div className="banner banner--danger">No pude cargar Hoy. La lectura no está confirmada.</div> : <p className="empty-mini">Cargando Hoy…</p>;

  const act = async (signal: Signal, action: SignalAction) => {
    setBusySignal(signal.id);
    setActionError(null);
    try {
      await postSignalAction(signal.id, action);
      await onRefresh();
    } catch {
      setActionError("La acción o su lectura posterior no pudo confirmarse. Actualizá antes de intentarla otra vez.");
    } finally {
      setBusySignal(null);
    }
  };

  const signalProps = {
    onOpenHarness,
    onOpenOrganization,
    onNavigate,
    onOpenEditor: onOpenEditor ? (id: string) => { void onOpenEditor(id).catch(() => setActionError("No pude abrir el editor; no se inició una tarea.")); } : undefined,
    pinnedIds: data.portfolio.pinned_signal_ids,
    empty: "No hay elementos en esta sección por ahora.",
    busySignal,
    onAction: act,
    onOpenTask,
    onOpenProject: (id: string) => {
      void onOpenProject(id).catch(() => setActionError("No pude abrir la referencia del proyecto; no se inició una tarea."));
    },
    onPrepareTask,
  };
  const recommendationIds = new Set(data.portfolio.recommendations.map((signal) => signal.id));
  const additionalSignals = (signals: Signal[]) => signals.filter((signal) => !recommendationIds.has(signal.id));
  const additionalCritical = additionalSignals(data.portfolio.critical_attention);
  const additionalContinue = additionalSignals(data.portfolio.work_to_continue);
  const additionalCommitments = additionalSignals(data.portfolio.client_commitments);
  const additionalPersonal = additionalSignals(data.portfolio.personal_opportunities);
  const additionalStaleProfiles = additionalSignals(data.portfolio.stale_profiles);
  const recommendationEmpty = data.portfolio.signal_status === "unavailable"
    ? "La inteligencia del portfolio no está disponible ahora. La actividad de Codex sigue visible; revisá las advertencias de fuentes."
    : data.portfolio.signal_status === "degraded"
      ? "No hay recomendaciones en las fuentes disponibles; algunas fuentes están degradadas."
      : "Tu cartera está tranquila. No hay una señal que requiera una decisión inmediata; podés continuar el trabajo activo o revisar compromisos próximos.";

  return (
    <div className="today-cockpit">
      {error && <div className="banner banner--warn view-note">No pude refrescar; mostrando el último estado conocido, sin confirmar su vigencia.</div>}
      {data.warnings.map((warning) => <div className="banner banner--warn view-note" key={warning}>{warning}</div>)}
      {actionError && <div className="banner banner--danger view-note" role="alert">No se pudo guardar la acción: {actionError}</div>}

      <section className="today-hero panel">
        <div><span className="b-label">Cockpit diario</span><h2>{data.date}</h2><p>{data.time_zone}</p></div>
        <div className="today-hero-right">
          <div className="today-metrics">
            <span><b>{data.counts.active}</b> tareas activas</span>
            <span><b>{data.counts.attention}</b> decisiones</span>
            <span><b>{data.counts.completed}</b> completadas</span>
            <span><b>{data.counts.failed}</b> fallidas</span>
            <span><b>{data.counts.retries}</b> reintentos</span>
          </div>
          <div className={`today-freshness today-freshness--${data.portfolio.signal_status}`}>
            <span className="dot" />
            {data.portfolio.signal_status === "available" ? "Inteligencia disponible" : data.portfolio.signal_status === "degraded" ? "Inteligencia parcial" : "Inteligencia no disponible"}
            <span title={data.portfolio.signals_observed_at ?? undefined}>
              {data.portfolio.signals_observed_at ? `· observada ${relativeTime(data.portfolio.signals_observed_at)}` : "· sin observación reciente"}
            </span>
            <button type="button" aria-label="Actualizar Hoy" title="Actualizar Hoy" onClick={() => { void onRefresh().catch(() => {}); }}><RotateCw size={13} /></button>
          </div>
        </div>
      </section>

      <WorkSessionsPanel sessions={data.portfolio.sessions} projects={projects} onChanged={onRefresh} onOpenTask={onOpenTask} />
      <RoutinePanel projects={projects} refreshKey={data.generated_at} />

      <SignalSection title="Ahora · recomendaciones principales" signals={data.portfolio.recommendations} {...signalProps}
        empty={recommendationEmpty} />

      <div className="today-two-col">
        <section className="today-portfolio-section panel today-section">
          <div className="section-head"><h2>Necesita atención</h2><span className="meta">{data.portfolio.critical_attention.length + data.attention.length}</span></div>
          <SignalSection title="" signals={additionalCritical} {...signalProps} empty="Las alertas críticas principales ya aparecen arriba." />
          <div className="section-head today-subhead"><h3>Decisiones de tareas</h3><span className="meta">{data.attention.length} ítems</span></div>
          <AttentionPanel items={data.attention} onOpenTask={onOpenTask} />
        </section>
        <section className="today-portfolio-section panel today-section">
          <div className="section-head"><h2>Continuar</h2><span className="meta">{data.active.length + data.portfolio.work_to_continue.length}</span></div>
          <InProgressColumn inProgress={data.active} history={[]} onOpenTask={onOpenTask} />
          {additionalContinue.length > 0 && <SignalSection title="Trabajo listo para retomar" signals={additionalContinue} {...signalProps} />}
        </section>
      </div>

      <div className="today-two-col">
        <SignalSection title="Compromisos de clientes" signals={additionalCommitments} {...signalProps} empty="Los compromisos prioritarios ya aparecen arriba o no hay otros próximos." />
        <SignalSection title="Oportunidades personales" signals={additionalPersonal} {...signalProps} empty="Las oportunidades principales ya aparecen arriba o no hay otras pendientes." />
      </div>

      {additionalStaleProfiles.length > 0 && (
        <SignalSection title="Perfiles incompletos o desactualizados" signals={additionalStaleProfiles} {...signalProps}
          empty="Los perfiles operativos están al día." />
      )}
      {data.portfolio.snoozed_signals.length > 0 && (
        <SignalSection title="Señales pospuestas" signals={data.portfolio.snoozed_signals} {...signalProps}
          empty="No hay señales pospuestas." />
      )}

      <section className="today-activity-block">
        <div className="section-head"><h2>Actividad de Codex</h2><span className="meta">hoy · {data.time_zone}</span></div>
        <div className="today-outcomes">
          <OutcomeSection title="Completadas hoy" tasks={data.completed} onOpenTask={onOpenTask} />
          <OutcomeSection title="Fallidas hoy" tasks={data.failed} onOpenTask={onOpenTask} />
          <OutcomeSection title="Canceladas hoy" tasks={data.cancelled} onOpenTask={onOpenTask} />
        </div>
        <div className="today-outcomes">
          <section className="today-section panel"><div className="section-head"><h2>Reintentos</h2><span className="meta">{data.retries.length}</span></div><ActivityRows items={data.retries} onOpenTask={onOpenTask} /></section>
          <section className="today-section panel"><div className="section-head"><h2>Cancelaciones</h2><span className="meta">{data.cancellations.length}</span></div><ActivityRows items={data.cancellations} onOpenTask={onOpenTask} /></section>
          <section className="today-section panel"><div className="section-head"><h2>Recuperaciones</h2><span className="meta">{data.recoveries.length}</span></div><ActivityRows items={data.recoveries} onOpenTask={onOpenTask} /></section>
        </div>
      </section>
    </div>
  );
}
