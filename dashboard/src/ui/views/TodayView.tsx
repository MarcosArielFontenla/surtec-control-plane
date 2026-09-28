import { useState } from "react";
import { ArrowUpRight, Check, Clock3, Pin, RotateCw, Send, ShieldCheck, X } from "lucide-react";
import type { Signal, SignalAction } from "../../../../lib/signals/types";
import type { TaskView, TodayActivity, TodayModel, ProjectView } from "../../../../lib/state/types";
import { postSignalAction } from "../api";
import { AttentionPanel } from "../components/AttentionPanel";
import { InProgressColumn } from "../components/InProgressColumn";
import { WorkSessionsPanel } from "../components/WorkSessionsPanel";
import { relativeTime } from "../relative-time";

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
}: {
  signal: Signal;
  pinned: boolean;
  busy: boolean;
  onAction: (signal: Signal, action: SignalAction) => void;
  onOpenTask: (id: string) => void;
  onOpenProject: (id: string) => void;
  onPrepareTask: (signal: Signal) => void;
}) {
  const taskId = signal.evidence.task_id;
  const category = signal.project_id === "surtec" && signal.source === "objective" ? "Objetivo SURTEC"
    : signal.project_kind ? PROJECT_CATEGORY_LABEL[signal.project_kind] : "Proyecto";
  const stateLabel = signal.state === "acknowledged" ? "Reconocida" : signal.state === "snoozed" ? "Pospuesta" : signal.state === "resolved" ? "Resuelta" : null;
  return (
    <article className={`today-signal panel${signal.severity === "critical" ? " today-signal--critical" : ""}`}>
      <div className="today-signal-topline">
        <span className={`signal-impact signal-impact--${signal.severity}`}>{SEVERITY_LABELS[signal.severity]}</span>
        <span className="today-signal-category">{category}</span>
        {stateLabel && <span className="today-signal-state">{stateLabel}</span>}
        {pinned && <span className="today-pinned"><Pin size={12} /> Fijada hoy</span>}
      </div>
      <p className="today-signal-project">{signal.project_id}</p>
      <h3>{signal.title}</h3>
      <p className="today-signal-reason">{signal.reason}</p>
      {typeof signal.evidence.primary_objective_title === "string" && <p className="today-signal-objective">Apoya el objetivo: <b>{signal.evidence.primary_objective_title}</b></p>}
      <p className="today-signal-next"><b>Siguiente paso</b> {signal.suggested_action}</p>
      <div className="today-signal-evidence">
        <span title={signal.evidence_at}>Evidencia {relativeTime(signal.evidence_at)}</span>
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
        <button type="button" className="ghost-btn" onClick={() => onOpenProject(signal.project_id)}>{signal.project_id === "surtec" && signal.source === "objective" ? "Abrir SURTEC" : "Abrir proyecto"} <ArrowUpRight size={13} /></button>
        {!(signal.project_id === "surtec" && signal.source === "objective") && <button type="button" className="ghost-btn" onClick={() => onPrepareTask(signal)}><Send size={13} /> Preparar tarea</button>}
      </div>
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
}) {
  return (
    <section className="today-portfolio-section">
      {title && <div className="section-head"><h2>{title}</h2><span className="meta">{signals.length}</span></div>}
      {signals.length === 0 ? <p className="empty-mini">{empty}</p> : (
        <div className="today-signal-grid">
          {signals.map((signal) => (
            <SignalCard key={signal.id} signal={signal} pinned={pinnedIds.includes(signal.id)} busy={busySignal === signal.id}
              onAction={onAction} onOpenTask={onOpenTask} onOpenProject={onOpenProject} onPrepareTask={onPrepareTask} />
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
  onRefresh,
  projects = [],
}: {
  data: TodayModel | null;
  error: string | null;
  onOpenTask: (id: string) => void;
  onOpenProject: (id: string) => Promise<void>;
  onPrepareTask: (signal: Signal) => void;
  onRefresh: () => Promise<TodayModel>;
  projects?: ProjectView[];
}) {
  const [busySignal, setBusySignal] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!data) return error ? <div className="banner banner--danger">No pude cargar Hoy ({error}).</div> : <p className="empty-mini">Cargando Hoy…</p>;

  const act = async (signal: Signal, action: SignalAction) => {
    setBusySignal(signal.id);
    setActionError(null);
    try {
      await postSignalAction(signal.id, action);
      await onRefresh();
    } catch (reason) {
      setActionError((reason as Error).message);
    } finally {
      setBusySignal(null);
    }
  };

  const signalProps = {
    pinnedIds: data.portfolio.pinned_signal_ids,
    empty: "No hay elementos en esta sección por ahora.",
    busySignal,
    onAction: act,
    onOpenTask,
    onOpenProject: (id: string) => {
      void onOpenProject(id).catch((reason) => setActionError((reason as Error).message));
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
      {error && <div className="banner banner--warn view-note">No pude refrescar ({error}); mostrando el último estado conocido.</div>}
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
