import { Wind } from "lucide-react";
import type { TaskView } from "../../../../lib/state/types";

const ST: Record<string, string> = { completed: "completed", failed: "failed" };

export function InProgressColumn({ inProgress, history }: { inProgress: TaskView[]; history: TaskView[] }) {
  return (
    <div>
      <div className="section-head"><h2>En curso</h2><span className="meta">{inProgress.length} activas</span></div>
      {inProgress.length === 0 ? (
        <div className="empty">
          <Wind />
          <p>Nada por ahora</p>
          <span className="hint">Las tareas despachadas aparecerán aquí en vivo.</span>
        </div>
      ) : (
        <div className="panel" style={{ padding: "6px 18px" }}>
          {inProgress.map((t) => (
            <div key={t.id} className="hist-row">
              <span className="hid">{t.id}</span><span className="agent">{t.agent}</span>
              <span className="htext">{t.title}</span><span className="st">{t.outcome ?? t.lifecycle}</span>
            </div>
          ))}
        </div>
      )}
      {history.length > 0 && (
        <div className="hist">
          <span className="b-label">Historial reciente</span>
          {history.map((t) => (
            <div key={t.id} className="hist-row">
              <span className="hid">{t.id}</span><span className="agent">{t.agent}</span>
              <span className="htext">{t.title}</span>
              <span className={`st ${ST[t.outcome ?? ""] ?? ""}`}>{t.outcome ?? t.lifecycle}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
