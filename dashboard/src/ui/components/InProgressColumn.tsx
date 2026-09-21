import { useState } from "react";
import { Wind } from "lucide-react";
import type { TaskView } from "../../../../lib/state/types";
import { cancelTask, retryTask } from "../api";

const ST: Record<string, string> = { completed: "completed", failed: "failed", cancelled: "failed" };

export function InProgressColumn({ inProgress, history, onOpenTask }: { inProgress: TaskView[]; history: TaskView[]; onOpenTask?: (id: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const control = async (task: TaskView, action: "cancel" | "retry") => {
    if (action === "cancel" && !window.confirm(`¿Cancelar ${task.id}? Se interrumpirá el turno activo de forma segura.`)) return;
    setBusy(task.id);
    setError(null);
    try {
      if (action === "cancel") await cancelTask(task.id);
      else await retryTask(task.id);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="section-head"><h2>En curso</h2><span className="meta">{inProgress.length} activas</span></div>
      {error && <div className="banner banner--danger">{error}</div>}
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
              <button type="button" className="task-link hid" onClick={() => onOpenTask?.(t.id)}>{t.id}</button><span className="agent">{t.agent}</span>
              <span className="htext">{t.title}</span>
              <span className="st">{t.outcome ?? t.lifecycle} · {t.attempts}/{t.max_attempts}</span>
              <button type="button" className="mini-cta outline" disabled={busy === t.id || t.cancel_requested_at !== null} onClick={() => control(t, "cancel")}>
                {t.cancel_requested_at ? "Cancelando" : "Cancelar"}
              </button>
            </div>
          ))}
        </div>
      )}
      {history.length > 0 && (
        <div className="hist">
          <span className="b-label">Historial reciente</span>
          {history.map((t) => (
            <div key={t.id} className="hist-row">
              <button type="button" className="task-link hid" onClick={() => onOpenTask?.(t.id)}>{t.id}</button><span className="agent">{t.agent}</span>
              <span className="htext">{t.title}</span>
              <span className={`st ${ST[t.outcome ?? ""] ?? ""}`}>{t.outcome ?? t.lifecycle}</span>
              {(t.outcome === "failed" || t.outcome === "cancelled") && t.attempts < t.max_attempts && (
                <button type="button" className="mini-cta outline" disabled={busy === t.id} onClick={() => control(t, "retry")}>Reintentar</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
