import { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { Inbox } from "../../../../lib/state/types";
import { getInbox } from "../api";
import { relativeTime } from "../relative-time";

export function IssuesView() {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repo, setRepo] = useState<string>("");

  useEffect(() => {
    let active = true;
    getInbox()
      .then((i) => { if (active) { setInbox(i); setError(null); } })
      .catch((e) => active && setError((e as Error).message));
    return () => { active = false; };
  }, []);

  const repoIds = useMemo(() => (inbox ? inbox.repos.map((r) => r.id) : []), [inbox]);
  const failed = inbox ? inbox.repos.filter((r) => !r.ok) : [];
  const allFailed = inbox != null && inbox.repos.length > 0 && failed.length === inbox.repos.length;
  const items = inbox ? (repo ? inbox.items.filter((i) => i.projectId === repo) : inbox.items) : [];

  return (
    <>
      <div className="section-head">
        <h2>Issues</h2>
        <span className="meta">{inbox ? `${items.length} abiertos` : "…"}</span>
      </div>

      <div className="field" style={{ maxWidth: 280, marginBottom: 16 }}>
        <label htmlFor="inbox-repo">Repositorio</label>
        <select id="inbox-repo" aria-label="Repositorio" value={repo} onChange={(e) => setRepo(e.target.value)}>
          <option value="">Todos los repos</option>
          {repoIds.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </div>

      {error && <div className="banner banner--warn">No pude leer los issues ({error}).</div>}
      {allFailed && <div className="banner banner--danger">GitHub no disponible (¿gh instalado y autenticado?).</div>}
      {!allFailed && failed.length > 0 && (
        <div className="banner banner--warn">No se pudo leer: {failed.map((r) => r.id).join(", ")}.</div>
      )}

      {!inbox && !error ? (
        <p className="empty-mini">cargando issues…</p>
      ) : items.length === 0 ? (
        <div className="empty"><p>Sin issues abiertos</p></div>
      ) : (
        <div className="panel" style={{ padding: "6px 18px" }}>
          {items.map((i) => (
            <div key={`${i.slug}#${i.number}`} className="issue-row">
              <span className="issue-repo">{i.projectId}</span>
              <span className="issue-num">#{i.number}</span>
              <a className="issue-title" href={i.url} target="_blank" rel="noreferrer">{i.title} <ExternalLink /></a>
              <span className="issue-labels">{i.labels.map((l) => <span key={l} className="badge-mini">{l}</span>)}</span>
              {i.author && <span className="issue-author">@{i.author}</span>}
              <span className="issue-when">{i.updatedAt ? relativeTime(i.updatedAt) : ""}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
