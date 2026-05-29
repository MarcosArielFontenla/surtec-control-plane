import type { AttentionItem } from "../../../../lib/state/types";

const LABEL: Record<AttentionItem["kind"], string> = {
  "needs-review": "Revisar",
  "awaiting-approval": "Aprobar",
  risk: "Riesgo",
  blocker: "Bloqueo",
};

export function AttentionPanel({ items }: { items: AttentionItem[] }) {
  return (
    <section style={{ flex: 1 }}>
      <h4>⚠ Necesita tu atención</h4>
      {items.length === 0 ? (
        <p style={{ color: "#999" }}>Todo en orden.</p>
      ) : (
        <ul style={{ paddingLeft: 16 }}>
          {items.map((a, i) => (
            <li key={`${a.task_id}-${i}`}>
              <em>{LABEL[a.kind]}</em> · {a.task_id} · {a.title}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
