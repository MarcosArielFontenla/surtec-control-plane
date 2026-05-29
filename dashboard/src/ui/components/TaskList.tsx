import type { TaskView } from "../../../../lib/state/types";

export function TaskList({ title, tasks }: { title: string; tasks: TaskView[] }) {
  return (
    <section style={{ flex: 1 }}>
      <h4>{title}</h4>
      {tasks.length === 0 ? (
        <p style={{ color: "#999" }}>Nada por ahora.</p>
      ) : (
        <ul style={{ paddingLeft: 16 }}>
          {tasks.map((t) => (
            <li key={t.id}>
              <strong>{t.id}</strong> · {t.agent} · {t.title}
              {t.outcome ? ` (${t.outcome})` : ` [${t.lifecycle}]`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
