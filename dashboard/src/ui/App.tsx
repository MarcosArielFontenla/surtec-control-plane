import { useOverview } from "./api";
import { Sidebar } from "./components/Sidebar";
import { ProjectCard } from "./components/ProjectCard";
import { TaskList } from "./components/TaskList";
import { AttentionPanel } from "./components/AttentionPanel";
import { NewTaskForm } from "./components/NewTaskForm";

export function App() {
  const { data, error } = useOverview();

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <header className="es-top">
          <span className="es-top__title">Estado vivo</span>
          <span className="es-live">
            <span className={`es-dot ${error ? "es-dot--danger" : "es-dot--ok"}`} />
            {error ? "sin conexión" : "en vivo"}
          </span>
        </header>
        <div className="app-content">
          <NewTaskForm />
          {error && (
            <div className="es-banner es-banner--warn">
              No pude refrescar ({error}); mostrando el último estado conocido.
            </div>
          )}
          {!data ? (
            <p className="es-empty">Cargando…</p>
          ) : (
            <>
              <section>
                <h4 className="es-section__title">Proyectos</h4>
                <div className="es-cards">
                  {data.projects.map((p) => <ProjectCard key={p.id} p={p} />)}
                </div>
              </section>
              <div className="es-cols">
                <TaskList title="En curso" tasks={data.inProgress} />
                <AttentionPanel items={data.attention} />
              </div>
              <TaskList title="Historial" tasks={data.history} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
