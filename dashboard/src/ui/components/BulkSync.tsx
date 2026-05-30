import { useState } from "react";
import { ArrowDownToLine, GitPullRequestArrow } from "lucide-react";
import { gitSync } from "../api";

type RepoStatus = "idle" | "running" | "ok" | "failed";
interface RepoResult { status: RepoStatus; output?: string }

const DOT: Record<RepoStatus, string> = {
  idle: "muted", running: "info", ok: "ok", failed: "danger",
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
    <div className="sync-actions">
      <span className="lbl">Sincronizar</span>
      <button type="button" className="ghost-btn" disabled={disabled} onClick={() => run("fetch")}>
        <ArrowDownToLine /> Fetch all
      </button>
      <button type="button" className="ghost-btn" disabled={disabled} onClick={() => run("pull")}>
        <GitPullRequestArrow /> Pull all
      </button>
      {rows.length > 0 && (
        <span className="sync-results">
          {rows.map(([id, r]) => (
            <span key={id} className={`pdot pdot--${DOT[r.status]}`} title={`${id}${r.output ? `: ${r.output}` : ""}`} />
          ))}
        </span>
      )}
    </div>
  );
}
