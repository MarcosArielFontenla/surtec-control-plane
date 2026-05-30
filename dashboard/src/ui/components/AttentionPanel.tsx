import { useState } from "react";
import type { AttentionItem } from "../../../../lib/state/types";
import { approveTask, rejectTask } from "../api";

const LABEL: Record<AttentionItem["kind"], string> = {
  "needs-review": "Revisar",
  "awaiting-approval": "Aprobar",
  risk: "Riesgo",
  blocker: "Bloqueo",
};
const TASK_KINDS: AttentionItem["kind"][] = ["needs-review", "awaiting-approval"];

function verification(v: AttentionItem["verification"]): { text: string; dot: string } {
  if (v === "passed") return { text: "verificado", dot: "es-dot--ok" };
  if (v === "failed") return { text: "verificación falló", dot: "es-dot--danger" };
  return { text: "sin verificar", dot: "es-dot--muted" };
}

export function AttentionPanel({ items }: { items: AttentionItem[] }) {
  const [error, setError] = useState<string | null>(null);

  const decide = async (id: string, action: "approve" | "reject") => {
    const ok = window.confirm(
      action === "approve"
        ? `¿Aprobar ${id}? Si es workspace-write, se pushea su branch a origin y se abre un PR.`
        : `¿Rechazar ${id}? Si es workspace-write, se descartan su worktree y branch.`,
    );
    if (!ok) return;
    setError(null);
    try {
      if (action === "approve") await approveTask(id);
      else await rejectTask(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section>
      <h4 className="es-section__title">Necesita tu atención</h4>
      {error && <div className="es-banner es-banner--danger">{error}</div>}
      {items.length === 0 ? (
        <p className="es-empty">Todo en orden.</p>
      ) : (
        <ul className="es-list">
          {items.map((a) => {
            const v = verification(a.verification);
            return (
              <li key={`${a.task_id}-${a.kind}-${a.title}`} className="es-row">
                <span className="es-chip">{LABEL[a.kind]}</span>
                <span className="es-row__id">{a.task_id}</span>
                <span>{a.title}</span>
                {TASK_KINDS.includes(a.kind) && (
                  <>
                    <span className="es-chip">
                      <span className={`es-dot ${v.dot}`} />
                      <span>{v.text}</span>
                    </span>
                    <button type="button" className="es-btn" onClick={() => decide(a.task_id, "approve")}>Aprobar</button>
                    <button type="button" className="es-btn es-btn--ghost" onClick={() => decide(a.task_id, "reject")}>Rechazar</button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
