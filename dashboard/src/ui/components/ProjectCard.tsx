import type { ProjectView, GitStatus } from "../../../../lib/state/types";
import { relativeTime } from "../relative-time";

function GitLine({ git }: { git: GitStatus | null }) {
  if (!git) return null;
  if (!git.ok) {
    return (
      <div className="es-gitline">
        <span className="es-dot es-dot--danger" />
        <span>git: no disponible</span>
      </div>
    );
  }
  return (
    <div className="es-gitline">
      <span>{git.branch ?? "(detached)"}</span>
      <span className={`es-dot ${git.dirty ? "es-dot--warn" : "es-dot--ok"}`} />
      <span>{git.dirty ? `${git.uncommitted} sin commitear` : "limpio"}</span>
      <span className="es-num">↑{git.ahead} ↓{git.behind}</span>
      {git.last_commit && (
        <span title={git.last_commit.at}>{git.last_commit.subject} · {relativeTime(git.last_commit.at)}</span>
      )}
    </div>
  );
}

export function ProjectCard({ p }: { p: ProjectView }) {
  return (
    <div className="es-card" style={{ minWidth: 220 }}>
      <div className="es-card__head">
        <span className="es-card__title">{p.id}</span>
        <span className="es-chip">
          <span className={`es-dot ${p.configured ? "es-dot--ok" : "es-dot--muted"}`} />
          <span>{p.configured ? "configurado" : "sin configurar"}</span>
        </span>
      </div>
      <div className="t-caption">{p.status}{p.health ? ` · ${p.health}` : ""}</div>
      <GitLine git={p.git} />
      <div className="t-caption">
        <span className="es-num">{p.task_counts.inProgress}</span> en curso · <span className="es-num">{p.task_counts.finished}</span> hechas
      </div>
      <div className="t-micro">{p.last_activity ? `últ. ${p.last_activity}` : "sin actividad"}</div>
    </div>
  );
}
