import { useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Code2, ExternalLink, Folder, GitBranch, GitPullRequestArrow, LayoutDashboard } from "lucide-react";
import type { ProjectView, GitStatus } from "../../../../lib/state/types";
import { relativeTime } from "../relative-time";
import { githubWebUrl } from "../../../../lib/github-url";
import { openProject, gitSync, getBranches, branchOp } from "../api";

function GitLine({ git, onBranchClick }: { git: GitStatus | null; onBranchClick: () => void }) {
  if (!git) return null;
  if (!git.ok) return <div className="git-line"><span className="dirty">git: no disponible</span></div>;
  return (
    <div className="git-line">
      <button type="button" className="branch" onClick={onBranchClick}><GitBranch />{git.branch ?? "(detached)"}</button>
      <span className="sep">·</span>
      <span className={git.dirty ? "dirty" : "clean"}>{git.dirty ? `${git.uncommitted} sin commitear` : "limpio"}</span>
      <span className="sep">·</span>
      <span className="ab">↑{git.ahead} ↓{git.behind}</span>
    </div>
  );
}

function useGitSync(project: ProjectView) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmPush, setConfirmPush] = useState(false);
  const run = (action: "fetch" | "pull" | "push") => {
    setBusy(action); setResult(null);
    gitSync(project.id, action)
      .then((r) => setResult({ ok: r.ok, text: r.output || (r.ok ? "ok" : "falló") }))
      .catch((e) => setResult({ ok: false, text: (e as Error).message }))
      .finally(() => { setBusy(null); setConfirmPush(false); });
  };
  return { busy, result, confirmPush, setConfirmPush, run };
}

function BranchPanel({ project, onClose }: { project: ProjectView; onClose: () => void }) {
  const git = project.git;
  const [branches, setBranches] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(git?.ok ? git.branch : null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [newName, setNewName] = useState("");

  const load = () => {
    if (loading) return;
    setLoading(true);
    getBranches(project.id)
      .then((b) => { setBranches(b.branches); setCurrent(b.current); })
      .catch((e) => setResult({ ok: false, text: (e as Error).message }))
      .finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  if (!git?.ok) return null;
  const op = (operation: "switch" | "create", name: string) => {
    setBusy(true); setResult(null);
    branchOp(project.id, operation, name)
      .then((r) => { setResult({ ok: r.ok, text: r.output || (r.ok ? "ok" : "falló") }); if (operation === "create" && r.ok) setNewName(""); load(); })
      .catch((e) => setResult({ ok: false, text: (e as Error).message }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="branches__panel">
      {git.dirty && <div className="branches__note">árbol sucio: commiteá o descartá para cambiar de branch</div>}
      {loading ? <span className="empty-mini">cargando…</span> : (
        <ul className="branches__list">
          {branches.map((branch) => (
            <li key={branch}>
              {branch === current ? <span className="branches__cur">● {branch}</span>
                : <button type="button" className="ghost-btn" disabled={busy || git.dirty} onClick={() => op("switch", branch)}>{branch}</button>}
            </li>
          ))}
        </ul>
      )}
      <div className="branches__create">
        <input className="input" placeholder="nueva-branch" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button type="button" className="ghost-btn" disabled={busy || newName.trim() === ""} onClick={() => op("create", newName.trim())}>Crear</button>
      </div>
      {result && <div className={`banner ${result.ok ? "banner--ok" : "banner--warn"}`}>{result.text}</div>}
      <button type="button" className="ghost-btn" onClick={onClose}>Cerrar</button>
    </div>
  );
}

export function ProjectCard({
  p,
  running = [],
  onOpenDetail = () => {},
}: {
  p: ProjectView;
  running?: string[];
  onOpenDetail?: () => void;
}) {
  const [openErr, setOpenErr] = useState<string | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const gs = useGitSync(p);
  const open = (target: "vscode" | "folder") => { setOpenErr(null); openProject(p.id, target).catch((e) => setOpenErr((e as Error).message)); };
  const gh = githubWebUrl(p.repo);
  const git = p.git;
  const ahead = git?.ok ? (git.ahead ?? 0) : 0;
  const canSync = !!git?.ok;

  return (
    <article className={`card${p.configured ? "" : " discovered"}`}>
      <div className="card-top">
        <h3 className="card-name">{p.id}</h3>
        <span className={`pill ${p.configured ? "ok" : "todo"}`}><span className="dot" />{p.configured ? "configurado" : "sin configurar"}</span>
      </div>

      <GitLine git={git} onBranchClick={() => setBranchOpen((v) => !v)} />
      {git?.ok && git.last_commit && (
        <p className="commit" title={git.last_commit.at}>{git.last_commit.subject} <span className="when">· {relativeTime(git.last_commit.at)}</span></p>
      )}

      <div className="counts">
        <span><b>{p.task_counts.inProgress}</b> en curso</span>
        <span><b>{p.task_counts.finished}</b> hechas</span>
        {running.map((label) => <span key={label} className="run-ind">{`● ${label}`}</span>)}
      </div>

      <div className="card-divider" />

      <div className="actions">
        <button type="button" className="ibtn primary" title="Abrir en VS Code" aria-label="VS Code" onClick={() => open("vscode")}><Code2 /> Code</button>
        <button type="button" className="ibtn icon-only" title="Carpeta" aria-label="Carpeta" onClick={() => open("folder")}><Folder /></button>
        {gh && <a className="ibtn icon-only" title="GitHub" aria-label="GitHub" href={gh} target="_blank" rel="noreferrer"><ExternalLink /></a>}
        <span className="spacer" />
        <button type="button" className="ibtn" title="Detalle operativo" aria-label={`Detalle operativo de ${p.id}`} onClick={onOpenDetail}><LayoutDashboard /> Detalle</button>
        {canSync && !gs.confirmPush && (
          <>
            <button type="button" className="ibtn" title="Fetch" aria-label="Fetch" disabled={gs.busy !== null} onClick={() => gs.run("fetch")}><ArrowDownToLine /></button>
            <button type="button" className="ibtn" title="Pull" aria-label="Pull" disabled={gs.busy !== null} onClick={() => gs.run("pull")}><GitPullRequestArrow /></button>
            <button type="button" className="ibtn" title="Push" aria-label="Push" disabled={gs.busy !== null || ahead === 0} onClick={() => gs.setConfirmPush(true)}><ArrowUpFromLine /></button>
          </>
        )}
        {canSync && gs.confirmPush && (
          <span className="push-confirm">
            <span>Publicar {ahead} commit{ahead === 1 ? "" : "s"} a origin/{git!.branch}?</span>
            <button type="button" className="ibtn primary" disabled={gs.busy !== null} onClick={() => gs.run("push")}>Confirmar</button>
            <button type="button" className="ibtn" onClick={() => gs.setConfirmPush(false)}>Cancelar</button>
          </span>
        )}
      </div>
      {gs.result && <div className={`banner ${gs.result.ok ? "banner--ok" : "banner--warn"}`}>{gs.result.text}</div>}

      {branchOpen && <BranchPanel project={p} onClose={() => setBranchOpen(false)} />}
      {openErr && <div className="banner banner--danger">{openErr}</div>}
    </article>
  );
}
