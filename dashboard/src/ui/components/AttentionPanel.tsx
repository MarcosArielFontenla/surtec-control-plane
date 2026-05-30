import { useState } from "react";
import type { AttentionItem } from "../../../../lib/state/types";
import { approveTask, rejectTask } from "../api";

const LABEL: Record<AttentionItem["kind"], string> = {
  "needs-review": "Revisar",
  "awaiting-approval": "Aprobar",
  risk: "Riesgo",
  blocker: "Bloqueo",
};
const TAG_CLASS: Record<AttentionItem["kind"], string> = {
  "needs-review": "approve",
  "awaiting-approval": "approve",
  risk: "risk",
  blocker: "block",
};
const TASK_KINDS: AttentionItem["kind"][] = ["needs-review", "awaiting-approval"];

function verificationText(v: AttentionItem["verification"]): string {
  if (v === "passed") return "verificado";
  if (v === "failed") return "verificación falló";
  return "sin verificar";
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
    <div className="panel" style={{ padding: "6px 18px" }}>
      {error && <div className="banner banner--danger">{error}</div>}
      {items.length === 0 ? (
        <p className="empty-mini" style={{ padding: "14px 0" }}>Todo en orden.</p>
      ) : (
        <div className="attn-list">
          {items.map((a) => {
            const isTask = TASK_KINDS.includes(a.kind);
            return (
              <div key={`${a.task_id}-${a.kind}-${a.title}`} className="attn-item">
                <span className={`tag ${TAG_CLASS[a.kind]}`}>{LABEL[a.kind]}</span>
                <span className="attn-id">{a.task_id}</span>
                <span className="attn-text">{a.title}</span>
                {isTask && <span className="badge-mini">{verificationText(a.verification)}</span>}
                {isTask && (
                  <div className="attn-actions">
                    <button type="button" className="mini-cta solid" onClick={() => decide(a.task_id, "approve")}>Aprobar</button>
                    <button type="button" className="mini-cta outline" onClick={() => decide(a.task_id, "reject")}>Rechazar</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
