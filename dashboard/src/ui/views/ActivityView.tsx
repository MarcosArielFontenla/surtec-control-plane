import { useEffect, useState } from "react";
import { GitCommitHorizontal, Zap } from "lucide-react";
import type { ActivityFeed, ActivityItem } from "../../../../lib/state/types";
import { getActivity } from "../api";
import { relativeTime } from "../relative-time";

type Filter = "all" | "commit" | "task";

export function ActivityView() {
  const [feed, setFeed] = useState<ActivityFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let active = true;
    getActivity()
      .then((f) => { if (active) { setFeed(f); setError(null); } })
      .catch((e) => active && setError((e as Error).message));
    return () => { active = false; };
  }, []);

  const items: ActivityItem[] = feed ? (filter === "all" ? feed.items : feed.items.filter((i) => i.kind === filter)) : [];

  return (
    <>
      <div className="section-head">
        <h2>Actividad</h2>
        <span className="meta">{feed ? `${items.length} eventos` : "…"}</span>
      </div>

      <div className="seg" role="group" aria-label="Filtro">
        <button type="button" className={`seg-btn${filter === "all" ? " on" : ""}`} onClick={() => setFilter("all")}>Todo</button>
        <button type="button" className={`seg-btn${filter === "commit" ? " on" : ""}`} onClick={() => setFilter("commit")}>Commits</button>
        <button type="button" className={`seg-btn${filter === "task" ? " on" : ""}`} onClick={() => setFilter("task")}>Tareas</button>
      </div>

      {error && <div className="banner banner--warn">No pude leer la actividad ({error}).</div>}

      {!feed && !error ? (
        <p className="empty-mini">cargando actividad…</p>
      ) : items.length === 0 ? (
        <div className="empty"><p>Sin actividad reciente</p></div>
      ) : (
        <div className="panel" style={{ padding: "6px 18px" }}>
          {items.map((i) => (
            <div key={i.kind === "commit" ? `c-${i.project}-${i.hash}` : `t-${i.taskId}`} className="feed-row">
              <span className={`feed-icon feed-icon--${i.kind}`}>{i.kind === "commit" ? <GitCommitHorizontal /> : <Zap />}</span>
              <span className="feed-project">{i.project}</span>
              <span className="feed-title">{i.kind === "commit" ? i.subject : i.title}</span>
              <span className="feed-meta">
                {i.kind === "commit"
                  ? <>#{i.hash}{i.author ? ` · ${i.author}` : ""}</>
                  : <>{i.agent} · <span className="badge-mini">{i.state}</span></>}
              </span>
              <span className="feed-when">{i.at ? relativeTime(i.at) : ""}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
