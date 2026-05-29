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

function verificationBadge(v: AttentionItem["verification"]): string {
  if (v === "passed") return "✓ verificado";
  if (v === "failed") return "✗ verificación falló";
  return "(sin verificar)";
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
      // the 3s polling refresh drops the decided item from the panel
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section style={{ flex: 1 }}>
      <h4>⚠ Necesita tu atención</h4>
      {error && <div style={{ background: "#f8d7da", padding: 6, borderRadius: 6, marginBottom: 8 }}>{error}</div>}
      {items.length === 0 ? (
        <p style={{ color: "#999" }}>Todo en orden.</p>
      ) : (
        <ul style={{ paddingLeft: 16 }}>
          {items.map((a) => (
            <li key={`${a.task_id}-${a.kind}-${a.title}`}>
              <em>{LABEL[a.kind]}</em> · {a.task_id} · {a.title}
              {TASK_KINDS.includes(a.kind) && (
                <>
                  {" "}
                  <small style={{ color: a.verification === "failed" ? "#b02a37" : "#666" }}>
                    {verificationBadge(a.verification)}
                  </small>{" "}
                  <button type="button" onClick={() => decide(a.task_id, "approve")}>Aprobar</button>{" "}
                  <button type="button" onClick={() => decide(a.task_id, "reject")}>Rechazar</button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
