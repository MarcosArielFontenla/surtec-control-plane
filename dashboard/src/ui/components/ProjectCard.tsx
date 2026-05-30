import { useState } from "react";
import type { ProjectView, GitStatus } from "../../../../lib/state/types";
import { relativeTime } from "../relative-time";
import { githubWebUrl } from "../../../../lib/github-url";
import { openProject, gitSync, getBranches, branchOp, getGithubCounts } from "../api";

function GitLine({ git }: { git: GitStatus | null }) {
  if (!git) return null;
  if (!git.ok) {
    return (
      <div className="es-gitline">
        <span className="es-dot es-dot--danger" />
        <span>git: no disponible</span>
      </div>
    );
  }
  return (
    <div className="es-gitline">
      <span>{git.branch ?? "(detached)"}</span>
      <span className={`es-dot ${git.dirty ? "es-dot--warn" : "es-dot--ok"}`} />
      <span>{git.dirty ? `${git.uncommitted} sin commitear` : "limpio"}</span>
      <span className="es-num">↑{git.ahead} ↓{git.behind}</span>
      {git.last_commit && (
        <span title={git.last_commit.at}>{git.last_commit.subject} · {relativeTime(git.last_commit.at)}</span>
      )}
    </div>
  );
}

function GitSyncRow({ project }: { project: ProjectView }) {
  const git = project.git;
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmPush, setConfirmPush] = useState(false);
  if (!git?.ok) return null;

  const run = (action: "fetch" | "pull" | "push") => {
    setBusy(action);
    setResult(null);
    gitSync(project.id, action)
      .then((r) => setResult({ ok: r.ok, text: r.output || (r.ok ? "ok" : "falló") }))
      .catch((e) => setResult({ ok: false, text: (e as Error).message }))
      .finally(() => { setBusy(null); setConfirmPush(false); });
  };

  const ahead = git.ahead ?? 0;
  return (
    <div className="es-gitsync">
      {confirmPush ? (
        <div className="es-gitsync__confirm">
          <span>Publicar {ahead} commit{ahead === 1 ? "" : "s"} a origin/{git.branch}?</span>
          <button type="button" className="es-btn es-btn--accent" disabled={busy !== null} onClick={() => run("push")}>Confirmar</button>
          <button type="button" className="es-btn es-btn--ghost" disabled={busy !== null} onClick={() => setConfirmPush(false)}>Cancelar</button>
        </div>
      ) : (
        <>
          <button type="button" className="es-btn es-btn--ghost" disabled={busy !== null} onClick={() => run("fetch")}>Fetch</button>
          <button type="button" className="es-btn es-btn--ghost" disabled={busy !== null} onClick={() => run("pull")}>Pull</button>
          <button type="button" className="es-btn es-btn--ghost" disabled={busy !== null || ahead === 0} onClick={() => setConfirmPush(true)}>Push</button>
        </>
      )}
      {result && <div className={`es-banner ${result.ok ? "es-banner--ok" : "es-banner--warn"}`}>{result.text}</div>}
    </div>
  );
}

function BranchControl({ project }: { project: ProjectView }) {
  const git = project.git;
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(git?.ok ? git.branch : null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [newName, setNewName] = useState("");
  if (!git?.ok) return null;

  const load = () => {
    if (loading) return; // avoid overlapping fetches (toggle + post-op refresh)
    setLoading(true);
    getBranches(project.id)
      .then((b) => { setBranches(b.branches); setCurrent(b.current); })
      .catch((e) => setResult({ ok: false, text: (e as Error).message }))
      .finally(() => setLoading(false));
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) load();
  };

  const op = (operation: "switch" | "create", name: string) => {
    setBusy(true);
    setResult(null);
    branchOp(project.id, operation, name)
      .then((r) => {
        setResult({ ok: r.ok, text: r.output || (r.ok ? "ok" : "falló") });
        if (operation === "create" && r.ok) setNewName("");
        load();
      })
      .catch((e) => setResult({ ok: false, text: (e as Error).message }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="es-branches">
      <button type="button" className="es-btn es-btn--ghost" onClick={toggle}>
        Branch: {git.branch ?? "(detached)"}
      </button>
      {open && (
        <div className="es-branches__panel">
          {git.dirty && <div className="es-branches__note">árbol sucio: commiteá o descartá para cambiar de branch</div>}
          {loading ? (
            <span className="es-empty">cargando…</span>
          ) : (
            <ul className="es-branches__list">
              {branches.map((b) => (
                <li key={b}>
                  {b === current ? (
                    <span className="es-branches__cur">● {b}</span>
                  ) : (
                    <button type="button" className="es-btn es-btn--ghost" disabled={busy || git.dirty} onClick={() => op("switch", b)}>{b}</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="es-branches__create">
            <input className="es-input" placeholder="nueva-branch" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button type="button" className="es-btn es-btn--ghost" disabled={busy || newName.trim() === ""} onClick={() => op("create", newName.trim())}>Crear</button>
          </div>
          {result && <div className={`es-banner ${result.ok ? "es-banner--ok" : "es-banner--warn"}`}>{result.text}</div>}
        </div>
      )}
    </div>
  );
}

function GithubCounts({ project }: { project: ProjectView }) {
  const gh = githubWebUrl(project.repo);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ ok: boolean; prs: number; issues: number; error?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!gh) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Load once on first open. A server response (ok or ok:false) is kept in `data` and not refetched.
    // A THROWN error (HTTP/network) goes to `err` only — leaving `data` null — so reopening retries it.
    if (next && !data && !loading) {
      setLoading(true);
      setErr(null);
      getGithubCounts(project.id)
        .then(setData)
        .catch((e) => setErr((e as Error).message))
        .finally(() => setLoading(false));
    }
  };

  return (
    <div className="es-gh">
      <button type="button" className="es-btn es-btn--ghost" onClick={toggle}>PRs · Issues</button>
      {open && (
        <span className="es-gh__counts" title={data?.error ?? err ?? undefined}>
          {loading ? "cargando…"
            : data ? (data.ok ? `PRs: ${data.prs} · Issues: ${data.issues}` : "GitHub: no disponible")
            : err ? "GitHub: no disponible"
            : null}
        </span>
      )}
    </div>
  );
}

export function ProjectCard({ p, running = [] }: { p: ProjectView; running?: string[] }) {
  const [openErr, setOpenErr] = useState<string | null>(null);
  const open = (target: "vscode" | "folder") => {
    setOpenErr(null);
    openProject(p.id, target).catch((e) => setOpenErr((e as Error).message));
  };
  const gh = githubWebUrl(p.repo);
  return (
    <div className="es-card">
      <div className="es-card__head">
        <span className="es-card__title">{p.id}</span>
        <span className="es-chip">
          <span className={`es-dot ${p.configured ? "es-dot--ok" : "es-dot--muted"}`} />
          <span>{p.configured ? "configurado" : "sin configurar"}</span>
        </span>
        {running.length > 0 && (
          <span className="es-chip es-chip--run">
            {running.map((label) => (
              <span key={label} className="es-run-ind">{`● ${label}`}</span>
            ))}
          </span>
        )}
      </div>
      <div className="t-caption">{p.status}{p.health ? ` · ${p.health}` : ""}</div>
      <GitLine git={p.git} />
      <div className="t-caption">
        <span className="es-num">{p.task_counts.inProgress}</span> en curso · <span className="es-num">{p.task_counts.finished}</span> hechas
      </div>
      <div className="t-micro">{p.last_activity ? `últ. ${p.last_activity}` : "sin actividad"}</div>
      <div className="es-card__actions">
        <button type="button" className="es-btn es-btn--ghost" onClick={() => open("vscode")}>VS Code</button>
        <button type="button" className="es-btn es-btn--ghost" onClick={() => open("folder")}>Carpeta</button>
        {gh && <a className="es-link" href={gh} target="_blank" rel="noreferrer">GitHub</a>}
      </div>
      <GitSyncRow project={p} />
      <BranchControl project={p} />
      <GithubCounts project={p} />
      {openErr && <div className="es-banner es-banner--danger">{openErr}</div>}
    </div>
  );
}
