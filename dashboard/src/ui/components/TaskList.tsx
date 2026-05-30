import type { TaskView } from "../../../../lib/state/types";

export function TaskList({ title, tasks }: { title: string; tasks: TaskView[] }) {
  return (
    <section>
      <h4 className="es-section__title">{title}</h4>
      {tasks.length === 0 ? (
        <p className="es-empty">Nada por ahora.</p>
      ) : (
        <ul className="es-list">
          {tasks.map((t) => (
            <li key={t.id} className="es-row">
              <span className="es-row__id">{t.id}</span>
              <span>{t.agent}</span>
              <span>{t.title}</span>
              <span className="es-chip">{t.outcome ?? t.lifecycle}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
