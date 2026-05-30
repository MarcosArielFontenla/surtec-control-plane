import { useState } from "react";
import { gitSync } from "../api";

type RepoStatus = "idle" | "running" | "ok" | "failed";
interface RepoResult { status: RepoStatus; output?: string }

const DOT: Record<RepoStatus, string> = {
  idle: "es-dot--muted", running: "es-dot--info", ok: "es-dot--ok", failed: "es-dot--danger",
};

export function BulkSync({ projectIds }: { projectIds: string[] }) {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, RepoResult>>({});

  const run = async (action: "fetch" | "pull") => {
    if (running || projectIds.length === 0) return;
    setRunning(true);
    setResults(Object.fromEntries(projectIds.map((id) => [id, { status: "idle" as RepoStatus }])));
    try {
      for (const id of projectIds) {
        setResults((prev) => ({ ...prev, [id]: { status: "running" } }));
        try {
          const r = await gitSync(id, action);
          setResults((prev) => ({ ...prev, [id]: { status: r.ok ? "ok" : "failed", output: r.output } }));
        } catch (e) {
          setResults((prev) => ({ ...prev, [id]: { status: "failed", output: (e as Error).message } }));
        }
      }
    } finally {
      setRunning(false);
    }
  };

  const disabled = running || projectIds.length === 0;
  const rows = Object.entries(results);
  return (
    <div className="es-bulk">
      <div className="es-bulk__bar">
        <span className="es-bulk__label">Sincronizar todo</span>
        <button type="button" className="es-btn es-btn--ghost" disabled={disabled} onClick={() => run("fetch")}>Fetch all</button>
        <button type="button" className="es-btn es-btn--ghost" disabled={disabled} onClick={() => run("pull")}>Pull all</button>
      </div>
      {rows.length > 0 && (
        <ul className="es-bulk__results">
          {rows.map(([id, r]) => (
            <li key={id} className="es-bulk__row" title={r.output}>
              <span className={`es-dot ${DOT[r.status]}`} />
              <span>{id}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
