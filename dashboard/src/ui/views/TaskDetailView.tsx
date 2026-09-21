import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, CircleAlert } from "lucide-react";
import type { TaskDetailModel, TaskEvent } from "../../../../lib/state/types";
import { fetchTaskDetail } from "../api";

function duration(value: number | null): string {
  if (value === null) return "—";
  const seconds = Math.floor(value / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function value(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function EventRows({ events, empty = "Sin evidencia." }: { events: TaskEvent[]; empty?: string }) {
  if (events.length === 0) return <p className="empty-mini">{empty}</p>;
  return <div className="evidence-list">{events.map((event) => (
    <div className="evidence-row" key={event.event_id}>
      <span className="event-time">{new Date(event.at).toLocaleString("es-AR")}</span>
      <span className="tag approve">{event.type}</span>
      <code>{JSON.stringify(event.payload)}</code>
    </div>
  ))}</div>;
}

function StringList({ items, empty = "Sin registros." }: { items: string[]; empty?: string }) {
  return items.length === 0 ? <p className="empty-mini">{empty}</p> : <ul className="detail-list">{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}

export function TaskDetailView({ taskId, onBack }: { taskId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<TaskDetailModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await fetchTaskDetail(taskId);
        if (active) { setDetail(next); setError(null); }
      } catch (reason) {
        if (active) setError((reason as Error).message);
      }
    };
    void load();
    const handle = setInterval(load, 3_000);
    return () => { active = false; clearInterval(handle); };
  }, [taskId]);

  if (!detail) return (
    <div className="detail-shell">
      <button type="button" className="ghost-btn" onClick={onBack}><ArrowLeft /> Volver</button>
      {error ? <div className="banner banner--danger">No pude cargar la tarea ({error}).</div> : <p className="empty-mini">Cargando evidencia…</p>}
    </div>
  );

  const { task, execution } = detail;
  const result = task.result;
  const orchestration = task.orchestration;
  return (
    <div className="detail-shell">
      <button type="button" className="ghost-btn detail-back" onClick={onBack}><ArrowLeft /> Volver</button>
      {error && <div className="banner banner--warn view-note">No pude refrescar ({error}); mostrando la última evidencia.</div>}

      <section className="detail-hero panel">
        <div><span className="b-label">{task.envelope.project} · {task.envelope.agent}</span><h2>{task.envelope.title}</h2><p>{task.envelope.id}</p></div>
        <span className={`detail-outcome ${task.outcome === "completed" || task.outcome === "partial" ? "ok" : "warn"}`}>
          {task.outcome === "completed" || task.outcome === "partial" ? <CheckCircle2 /> : <CircleAlert />}{task.outcome ?? task.lifecycle}
        </span>
      </section>

      <section className="detail-stats">
        <div className="panel"><span className="b-label">Lifecycle</span><b>{task.lifecycle}</b></div>
        <div className="panel"><span className="b-label">Duración</span><b>{duration(detail.duration_ms)}</b></div>
        <div className="panel"><span className="b-label">Intentos</span><b>{orchestration?.attempts ?? 0}/{orchestration?.max_attempts ?? "—"}</b></div>
        <div className="panel"><span className="b-label">Tokens</span><b>{orchestration?.cumulative_tokens ?? 0}/{orchestration?.max_total_tokens ?? "—"}</b></div>
        <div className="panel"><span className="b-label">Cleanup</span><b>{detail.cleanup.status}</b></div>
      </section>

      <div className="detail-grid">
        <section className="detail-card panel"><h3>Resultado</h3><p className="detail-summary">{result?.summary ?? "Todavía no hay resultado estructurado."}</p><span className="b-label">Archivos</span><StringList items={result?.files_changed ?? []} /></section>
        <section className="detail-card panel"><h3>Ejecución</h3><dl className="detail-dl">
          <dt>Modo</dt><dd>{value(execution.mode)}</dd><dt>Thread</dt><dd>{value(execution.thread_id)}</dd><dt>Turn</dt><dd>{value(execution.turn_id)}</dd>
          <dt>Branch</dt><dd>{value(execution.branch)}</dd><dt>Commit</dt><dd>{value(execution.committed)}</dd><dt>Diffstat</dt><dd>{value(execution.diffstat)}</dd>
          <dt>Trace</dt><dd>{execution.trace_id ? `${execution.trace_id} / ${execution.span_id ?? "—"}` : "no habilitado"}</dd>
        </dl></section>
      </div>

      <section className="detail-card panel"><h3>Diff <span className="meta">{detail.diff.status}{detail.diff.truncated ? " · truncado" : ""}</span></h3>{detail.diff.content ? <pre className="diff-view">{detail.diff.content}</pre> : <p className="empty-mini">No hay diff disponible.</p>}</section>

      <div className="detail-grid">
        <section className="detail-card panel"><h3>Comandos</h3><StringList items={result?.commands_run ?? []} /><h3 className="detail-subhead">Tests declarados</h3><StringList items={result?.tests_run ?? []} /></section>
        <section className="detail-card panel"><h3>Verificación</h3>{!result?.verification ? <p className="empty-mini">No solicitada.</p> : <><p className={`verification-state ${result.verification.status}`}>{result.verification.status}</p>{result.verification.checks.map((check) => <div className="verify-check" key={check.command}><b>{check.ok ? "✓" : "×"} {check.command}</b>{check.output_tail && <pre>{check.output_tail}</pre>}</div>)}</>}</section>
      </div>

      <div className="detail-grid">
        <section className="detail-card panel"><h3>Policy</h3><EventRows events={detail.policy_decisions} /></section>
        <section className="detail-card panel"><h3>Approvals</h3><EventRows events={detail.approvals} /></section>
        <section className="detail-card panel"><h3>Uso</h3><EventRows events={detail.usage} /></section>
        <section className="detail-card panel"><h3>Reintentos y recovery</h3><EventRows events={detail.retries} /></section>
      </div>

      <div className="detail-grid">
        <section className="detail-card panel"><h3>Revisión y cleanup</h3><EventRows events={detail.review_history} /><dl className="detail-dl detail-cleanup"><dt>Estado</dt><dd>{detail.cleanup.status}</dd><dt>Última evidencia</dt><dd>{detail.cleanup.at ? new Date(detail.cleanup.at).toLocaleString("es-AR") : "—"}</dd></dl></section>
        <section className="detail-card panel"><h3>Riesgos y bloqueos</h3><span className="b-label">Riesgos</span><StringList items={result?.risks ?? []} /><span className="b-label">Bloqueos</span><StringList items={result?.blockers ?? []} /><span className="b-label">Próximos pasos</span><StringList items={result?.next_steps ?? []} /></section>
      </div>

      <section className="detail-card panel"><h3>Lifecycle completo</h3><EventRows events={detail.events} /></section>
    </div>
  );
}
