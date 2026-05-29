import type { ProjectView } from "../../../../lib/state/types";

export function ProjectCard({ p }: { p: ProjectView }) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, minWidth: 180 }}>
      <strong>{p.id}</strong>
      <div style={{ fontSize: 12, color: "#666" }}>
        {p.status}{p.health ? ` · ${p.health}` : ""}
      </div>
      <div style={{ fontSize: 12 }}>
        {p.task_counts.inProgress} en curso · {p.task_counts.finished} hechas
      </div>
      <div style={{ fontSize: 11, color: "#999" }}>
        {p.last_activity ? `últ. ${p.last_activity}` : "sin actividad"}
      </div>
    </div>
  );
}
