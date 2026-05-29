import { useOverview } from "./api";
import { Sidebar } from "./components/Sidebar";
import { ProjectCard } from "./components/ProjectCard";
import { TaskList } from "./components/TaskList";
import { AttentionPanel } from "./components/AttentionPanel";

export function App() {
  const { data, error } = useOverview();

  return (
    <div style={{ display: "flex", fontFamily: "system-ui, sans-serif", minHeight: "100vh" }}>
      <Sidebar />
      <main style={{ flex: 1, padding: 24 }}>
        <h2 style={{ marginTop: 0 }}>Estado vivo</h2>
        {error && (
          <div style={{ background: "#fff3cd", padding: 8, borderRadius: 6, marginBottom: 12 }}>
            No pude refrescar ({error}); mostrando el último estado conocido.
          </div>
        )}
        {!data ? (
          <p>Cargando…</p>
        ) : (
          <>
            <section>
              <h4>Proyectos</h4>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {data.projects.map((p) => <ProjectCard key={p.id} p={p} />)}
              </div>
            </section>
            <div style={{ display: "flex", gap: 24, marginTop: 24 }}>
              <TaskList title="En curso" tasks={data.inProgress} />
              <AttentionPanel items={data.attention} />
            </div>
            <div style={{ marginTop: 24 }}>
              <TaskList title="Historial" tasks={data.history} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
