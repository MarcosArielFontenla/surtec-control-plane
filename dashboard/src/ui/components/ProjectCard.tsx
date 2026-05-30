import type { ProjectView, GitStatus } from "../../../../lib/state/types";

function GitLine({ git }: { git: GitStatus | null }) {
  if (!git) return null;
  if (!git.ok) return <div style={{ fontSize: 12, color: "#b02a37" }}>git: no disponible</div>;
  return (
    <div style={{ fontSize: 12, color: "#555", display: "flex", gap: 8, flexWrap: "wrap" }}>
      <span>⎇ {git.branch ?? "(detached)"}</span>
      <span style={{ color: git.dirty ? "#b02a37" : "#198754" }}>
        {git.dirty ? `● ${git.uncommitted} sin commitear` : "✓ limpio"}
      </span>
      <span>↑{git.ahead} ↓{git.behind}</span>
      {git.last_commit && <span title={git.last_commit.at}>· {git.last_commit.subject}</span>}
    </div>
  );
}

export function ProjectCard({ p }: { p: ProjectView }) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, minWidth: 180 }}>
      <strong>{p.id}</strong>{" "}
      <small style={{ fontSize: 11, color: p.configured ? "#198754" : "#999" }}>
        {p.configured ? "configurado" : "sin configurar"}
      </small>
      <div style={{ fontSize: 12, color: "#666" }}>
        {p.status}{p.health ? ` · ${p.health}` : ""}
      </div>
      <GitLine git={p.git} />
      <div style={{ fontSize: 12 }}>
        {p.task_counts.inProgress} en curso · {p.task_counts.finished} hechas
      </div>
      <div style={{ fontSize: 11, color: "#999" }}>
        {p.last_activity ? `últ. ${p.last_activity}` : "sin actividad"}
      </div>
    </div>
  );
}
