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

  if (!state) return <li className="es-row"><span className="es-row__id">{id}</span><span className="es-empty">cargando…</span></li>;

  const cmds = state.commands;
  const oneshots = ONESHOT_KEYS.filter((k) => cmds[k]);
  const hasAny = Boolean(cmds.dev) || oneshots.length > 0;

  return (
    <li className="es-row es-row--proc">
      <span className="es-row__id">{id}</span>
      {!hasAny && <span className="es-empty">sin comandos configurados</span>}
      {cmds.dev && (
        <span className="es-proc-slot">
          {state.running.dev
            ? <>
                <button type="button" className="es-btn es-btn--ghost" title="Ver salida en consola" onClick={() => onSelect(state.running.dev!)}>● dev</button>
                <button type="button" className="es-btn es-btn--accent" onClick={() => stop(state.running.dev!)}>Detener</button>
              </>
            : <button type="button" className="es-btn" onClick={() => run("dev")}>dev</button>}
        </span>
      )}
      {oneshots.length > 0 && (
        <span className="es-proc-slot">
          {state.running.oneshot
            ? <>
                <button type="button" className="es-btn es-btn--ghost" title="Ver salida en consola" onClick={() => onSelect(state.running.oneshot!)}>● en curso</button>
                <button type="button" className="es-btn es-btn--accent" onClick={() => stop(state.running.oneshot!)}>Detener</button>
              </>
            : oneshots.map((k) => (
                <button key={k} type="button" className="es-btn es-btn--ghost" onClick={() => run(k)}>{k}</button>
              ))}
        </span>
      )}
      {err && <span className="es-banner es-banner--danger">{err}</span>}
    </li>
  );
}

export function ProcesosView({ projectIds }: { projectIds: string[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <section className="es-cols">
      <div style={{ flex: 1 }}>
        <h4 className="es-section__title">Procesos</h4>
        <ul className="es-list">
          {projectIds.map((id) => <ProjectRow key={id} id={id} onSelect={setSelected} />)}
        </ul>
      </div>
      <div style={{ flex: 1 }}>
        <h4 className="es-section__title">Consola</h4>
        {selected ? <RunConsole runId={selected} /> : <p className="es-empty">Elegí un proceso para ver su salida.</p>}
      </div>
    </section>
  );
}
