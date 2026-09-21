import type { TaskView, TodayActivity, TodayModel } from "../../../../lib/state/types";
import { AttentionPanel } from "../components/AttentionPanel";
import { InProgressColumn } from "../components/InProgressColumn";
import { relativeTime } from "../relative-time";

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

export function TodayView({ data, error, onOpenTask }: { data: TodayModel | null; error: string | null; onOpenTask: (id: string) => void }) {
  if (!data) return error ? <div className="banner banner--danger">No pude cargar Hoy ({error}).</div> : <p className="empty-mini">Cargando Hoy…</p>;
  return (
    <>
      {error && <div className="banner banner--warn view-note">No pude refrescar ({error}); mostrando el último estado conocido.</div>}
      {data.warnings.map((warning) => <div className="banner banner--warn view-note" key={warning}>{warning}</div>)}
      <section className="today-hero panel">
        <div><span className="b-label">Jornada operativa</span><h2>{data.date}</h2><p>{data.time_zone}</p></div>
        <div className="today-metrics">
          <span><b>{data.counts.active}</b> activas</span>
          <span><b>{data.counts.attention}</b> atención</span>
          <span><b>{data.counts.completed}</b> completadas</span>
          <span><b>{data.counts.failed}</b> fallidas</span>
          <span><b>{data.counts.retries}</b> reintentos</span>
        </div>
      </section>

      <div className="two-col today-primary">
        <InProgressColumn inProgress={data.active} history={[]} onOpenTask={onOpenTask} />
        <div>
          <div className="section-head"><h2>Decisiones pendientes</h2><span className="meta">{data.attention.length} ítems</span></div>
          <AttentionPanel items={data.attention} onOpenTask={onOpenTask} />
        </div>
      </div>

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
    </>
  );
}
