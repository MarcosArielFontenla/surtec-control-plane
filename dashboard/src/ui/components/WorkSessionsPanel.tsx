import { useState, type FormEvent } from "react";
import type { TodayWorkSessionState, WorkSessionView, ProjectView } from "../../../../lib/state/types";
import { actOnWorkSession, startWorkSession } from "../api";

function formatFocusedTime(milliseconds: number): string {
  const totalMinutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

function taskEventLabel(event: string | null): string {
  const labels: Record<string, string> = {
    "diff-captured": "diff registrado",
    verification: "verificación registrada",
    completed: "tarea completada",
    failed: "tarea fallida",
    "needs-review": "requiere revisión",
    started: "tarea iniciada",
    warning: "advertencia registrada",
  };
  return event ? labels[event] ?? event : "sin eventos registrados";
}

function stateLabel(session: WorkSessionView): string {
  if (session.status === "active") return "En curso";
  if (session.status === "paused") return "Pausada";
  return "Completada";
}

function splitIds(value: string): string[] {
  return [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
}

function WorkSessionCard({ session, onChanged, onOpenTask, canResume = true }: {
  session: WorkSessionView;
  onChanged: () => Promise<unknown>;
  onOpenTask?: (id: string) => void;
  canResume?: boolean;
}) {
  const [note, setNote] = useState("");
  const [taskIds, setTaskIds] = useState("");
  const [runIds, setRunIds] = useState("");
  const [nextAction, setNextAction] = useState(session.next_action ?? "");
  const [resultSummary, setResultSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent, action: Parameters<typeof actOnWorkSession>[1], clear?: () => void) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await actOnWorkSession(session.id, action);
      clear?.();
      await onChanged();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runSimpleAction = async (action: Parameters<typeof actOnWorkSession>[1]) => {
    setBusy(true);
    setError(null);
    try {
      await actOnWorkSession(session.id, action);
      await onChanged();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`work-session-card work-session-card--${session.status}`}>
      <div className="work-session-card__head">
        <div><span className={`work-session-status work-session-status--${session.status}`}>{stateLabel(session)}</span><h3>{session.objective}</h3></div>
        <div className="work-session-card__time"><b>{formatFocusedTime(session.elapsed_focused_ms)}</b><span>tiempo enfocado</span></div>
      </div>
      <dl className="work-session-facts">
        <div><dt>Proyecto</dt><dd>{session.project_id}</dd></div>
        <div><dt>Branch</dt><dd>{session.branch ?? "Sin branch detectada"}</dd></div>
        <div><dt>Inicio</dt><dd>{new Date(session.started_at).toLocaleString()}</dd></div>
        {session.completed_at && <div><dt>Finalizada</dt><dd>{new Date(session.completed_at).toLocaleString()}</dd></div>}
      </dl>

      {session.notes.length > 0 && <div className="work-session-context"><h4>Cambios y notas</h4><ul>{session.notes.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></div>}
      {session.related_tasks.length > 0 && <div className="work-session-context"><h4>Tareas relacionadas</h4><ul>{session.related_tasks.map((task) => (
        <li key={task.id}>
          {onOpenTask ? <button type="button" className="work-session-link-button" onClick={() => onOpenTask(task.id)}>{task.id}{task.title ? ` · ${task.title}` : ""}</button> : <b>{task.id}</b>}
          <span>{task.available ? `${task.outcome ?? task.lifecycle} · ${taskEventLabel(task.latest_event)} · verificación ${task.verification ?? "sin dato"}` : "tarea no disponible en el estado local"}</span>
          {task.pull_request_url && <a href={task.pull_request_url} target="_blank" rel="noreferrer">Pull request registrada</a>}
        </li>
      ))}</ul></div>}
      {session.related_runs.length > 0 && <div className="work-session-context"><h4>Procesos relacionados</h4><ul>{session.related_runs.map((run) => (
        <li key={run.id}><b>{run.id}</b><span>{run.status === "unavailable" ? "historial de proceso no disponible tras reiniciar el servidor" : `${run.kind === "dev" ? "dev" : "comando puntual"} · ${run.status}${run.exit_code == null ? "" : ` · código ${run.exit_code}`}`}</span></li>
      ))}</ul></div>}
      {session.next_action && <p className="work-session-next"><b>Próximo paso</b> {session.next_action}</p>}
      {session.result_summary && <p className="work-session-result"><b>Resultado</b> {session.result_summary}</p>}

      {session.status !== "completed" && <div className="work-session-controls">
        {session.status === "active" ? (
          <form className="work-session-form work-session-form--inline" onSubmit={(event) => void submit(event, { action: "pause", next_action: nextAction })}>
            <label>Próximo paso al pausar<input value={nextAction} onChange={(event) => setNextAction(event.target.value)} maxLength={1000} required placeholder="Qué retomar y dónde seguir" /></label>
            <button type="submit" className="ibtn" disabled={busy}>Pausar sesión</button>
          </form>
        ) : <button type="button" className="ibtn primary" disabled={busy || !canResume} title={!canResume ? "Ya hay otra sesión activa" : undefined} onClick={() => void runSimpleAction({ action: "resume" })}>Reanudar sesión</button>}

        <form className="work-session-form work-session-form--inline" onSubmit={(event) => void submit(event, { action: "add-note", note }, () => setNote(""))}>
          <label>Nota rápida<input value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} required placeholder="Qué cambió o qué observaste" /></label>
          <button type="submit" className="ibtn" disabled={busy}>Guardar nota</button>
        </form>

        <form className="work-session-form work-session-form--inline" onSubmit={(event) => {
          const tasks = splitIds(taskIds);
          const runs = splitIds(runIds);
          if (tasks.length + runs.length === 0) { event.preventDefault(); setError("Ingresá al menos una tarea o proceso."); return; }
          void submit(event, { action: "associate", ...(tasks.length ? { task_ids: tasks } : {}), ...(runs.length ? { run_ids: runs } : {}) }, () => { setTaskIds(""); setRunIds(""); });
        }}>
          <label>Tareas relacionadas<input value={taskIds} onChange={(event) => setTaskIds(event.target.value)} placeholder="IDs separados por coma" /></label>
          <label>Procesos relacionados<input value={runIds} onChange={(event) => setRunIds(event.target.value)} placeholder="IDs separados por coma" /></label>
          <button type="submit" className="ibtn" disabled={busy}>Vincular</button>
        </form>

        <details className="work-session-complete">
          <summary>Completar sesión</summary>
          <form className="work-session-form" onSubmit={(event) => void submit(event, { action: "complete", result_summary: resultSummary, next_action: nextAction })}>
            <label>Resultado<textarea value={resultSummary} onChange={(event) => setResultSummary(event.target.value)} maxLength={2000} required placeholder="Qué quedó hecho y cómo se verificó" /></label>
            <label>Próximo paso<input value={nextAction} onChange={(event) => setNextAction(event.target.value)} maxLength={1000} required placeholder="Una acción concreta o none" /></label>
            <button type="submit" className="ibtn primary" disabled={busy}>Guardar cierre</button>
          </form>
        </details>
      </div>}
      {error && <p className="work-session-error" role="alert">{error}</p>}
    </article>
  );
}

export function WorkSessionsPanel({ sessions, projects, projectId, onChanged, onOpenTask }: {
  sessions: TodayWorkSessionState;
  projects: ProjectView[];
  projectId?: string;
  onChanged: () => Promise<unknown>;
  onOpenTask?: (id: string) => void;
}) {
  const [objective, setObjective] = useState("");
  const [selectedProject, setSelectedProject] = useState(projectId ?? "");
  const [taskIds, setTaskIds] = useState("");
  const [runIds, setRunIds] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopedActive = projectId ? sessions.active.filter((session) => session.project_id === projectId) : sessions.active;
  const scopedPaused = projectId ? sessions.paused.filter((session) => session.project_id === projectId) : sessions.paused;
  const scopedCompleted = projectId ? sessions.completed.filter((session) => session.project_id === projectId) : sessions.completed;
  const activeElsewhere = projectId ? sessions.active.find((session) => session.project_id !== projectId) : undefined;
  const projectOptions = projects.map((project) => project.id);
  const newSessionProject = projectId ?? (selectedProject && projectOptions.includes(selectedProject) ? selectedProject : projectOptions[0] ?? "");

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await startWorkSession({
        project_id: newSessionProject,
        objective,
        ...(splitIds(taskIds).length ? { related_task_ids: splitIds(taskIds) } : {}),
        ...(splitIds(runIds).length ? { related_run_ids: splitIds(runIds) } : {}),
      });
      setObjective(""); setTaskIds(""); setRunIds("");
      await onChanged();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`work-sessions panel${projectId ? " project-detail-section" : " today-section"}`}>
      <div className="section-head"><div><h2>Sesiones de trabajo</h2><p>Contexto local para continuar y cerrar el día con un próximo paso. No incluyas credenciales ni secretos.</p></div><span className="meta">{sessions.available ? `${scopedActive.length} activa · ${scopedPaused.length} pausadas` : "No disponible"}</span></div>
      {!sessions.available ? <p className="work-session-error">{sessions.unavailable_reason ?? "El estado local de sesiones no está disponible."}</p> : <>
        {activeElsewhere && <p className="work-session-lock" role="status">Hay una sesión activa en {activeElsewhere.project_id}. Pausala o completala antes de iniciar otra.</p>}
        {scopedActive.length + scopedPaused.length === 0 && !activeElsewhere && <p className="empty-mini">No hay sesiones activas o pausadas para este proyecto.</p>}
        {scopedActive.map((session) => <WorkSessionCard key={session.id} session={session} onChanged={onChanged} onOpenTask={onOpenTask} />)}
        {scopedPaused.map((session) => <WorkSessionCard key={session.id} session={session} onChanged={onChanged} onOpenTask={onOpenTask} canResume={sessions.active.length === 0} />)}
        {scopedCompleted.length > 0 && <div className="work-session-completed-list"><h3>Cierres recientes</h3>{scopedCompleted.map((session) => <WorkSessionCard key={session.id} session={session} onChanged={onChanged} onOpenTask={onOpenTask} />)}</div>}
        {!sessions.active.length && (projectId || projectOptions.length > 0) && (
          <form className="work-session-start work-session-form" onSubmit={(event) => void create(event)}>
            <h3>Iniciar una sesión</h3>
            {!projectId && <label>Proyecto
              <select aria-label="Proyecto para la sesión" value={newSessionProject} onChange={(event) => setSelectedProject(event.target.value)} required>
                {projectOptions.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </label>}
            {projectId && <p>Proyecto: <b>{projectId}</b> · se registra el branch Git actual si está disponible.</p>}
            <label>Objetivo<textarea aria-label="Objetivo de la sesión" value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={2000} required placeholder="Qué intentás terminar en este bloque de trabajo" /></label>
            <div className="work-session-form__row">
              <label>Tareas relacionadas (opcional)<input value={taskIds} onChange={(event) => setTaskIds(event.target.value)} placeholder="IDs separados por coma" /></label>
              <label>Procesos relacionados (opcional)<input value={runIds} onChange={(event) => setRunIds(event.target.value)} placeholder="IDs separados por coma" /></label>
            </div>
            <button type="submit" className="ibtn primary" disabled={busy || !newSessionProject}>Iniciar sesión</button>
          </form>
        )}
        {error && <p className="work-session-error" role="alert">{error}</p>}
      </>}
    </section>
  );
}
