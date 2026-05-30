import { useEffect, useState, useCallback } from "react";
import type { ProjectCommands } from "../../../../lib/state/types";
import { getProjectCommands, runProject, stopRun } from "../api";
import { RunConsole } from "../components/RunConsole";

const ONESHOT_KEYS: Exclude<keyof ProjectCommands, "dev">[] = ["build", "test", "lint", "install"];

interface ProjectState {
  commands: ProjectCommands;
  running: { dev: string | null; oneshot: string | null };
}

function ProjectRow({ id, onSelect }: { id: string; onSelect: (runId: string) => void }) {
  const [state, setState] = useState<ProjectState | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setState(await getProjectCommands(id)); setErr(null); }
    catch (e) { setErr((e as Error).message); }
  }, [id]);

  useEffect(() => {
    let active = true;
    const tick = async () => { if (active) await refresh(); };
    void tick();
    const h = setInterval(tick, 2000);
    return () => { active = false; clearInterval(h); };
  }, [refresh]);

  const run = async (key: string) => {
    setErr(null);
    try { const { runId } = await runProject(id, key); onSelect(runId); await refresh(); }
    catch (e) { setErr((e as Error).message); }
  };
  const stop = async (runId: string) => {
    setErr(null);
    try { await stopRun(runId); await refresh(); } catch (e) { setErr((e as Error).message); }
  };

  if (!state) return <div className="proc-row"><span className="hid">{id}</span><span className="empty-mini">cargando…</span></div>;

  const cmds = state.commands;
  const oneshots = ONESHOT_KEYS.filter((k) => cmds[k]);
  const hasAny = Boolean(cmds.dev) || oneshots.length > 0;

  return (
    <div className="proc-row">
      <span className="hid">{id}</span>
      {!hasAny && <span className="empty-mini">sin comandos configurados</span>}
      {cmds.dev && (
        <span className="proc-slot">
          {state.running.dev
            ? <>
                <button type="button" className="ibtn" title="Ver salida en consola" onClick={() => onSelect(state.running.dev!)}>● dev</button>
                <button type="button" className="ibtn primary" onClick={() => stop(state.running.dev!)}>Detener</button>
              </>
            : <button type="button" className="ibtn primary" onClick={() => run("dev")}>dev</button>}
        </span>
      )}
      {oneshots.length > 0 && (
        <span className="proc-slot">
          {state.running.oneshot
            ? <>
                <button type="button" className="ibtn" title="Ver salida en consola" onClick={() => onSelect(state.running.oneshot!)}>● en curso</button>
                <button type="button" className="ibtn primary" onClick={() => stop(state.running.oneshot!)}>Detener</button>
              </>
            : oneshots.map((k) => (
                <button key={k} type="button" className="ibtn" onClick={() => run(k)}>{k}</button>
              ))}
        </span>
      )}
      {err && <span className="banner banner--danger">{err}</span>}
    </div>
  );
}

export function ProcesosView({ projectIds }: { projectIds: string[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="two-col">
      <div>
        <div className="section-head"><h2>Procesos</h2><span className="meta">{projectIds.length} repos</span></div>
        <div className="panel" style={{ padding: "6px 18px" }}>
          {projectIds.map((id) => <ProjectRow key={id} id={id} onSelect={setSelected} />)}
        </div>
      </div>
      <div>
        <div className="section-head"><h2>Consola</h2></div>
        {selected ? <RunConsole runId={selected} /> : <div className="empty"><p>Elegí un proceso para ver su salida.</p></div>}
      </div>
    </div>
  );
}
