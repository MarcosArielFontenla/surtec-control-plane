import { useEffect, useState } from "react";
import { fetchDispatchOptions, createTask, type DispatchOptions } from "../api";

export function NewTaskForm() {
  const [options, setOptions] = useState<DispatchOptions["projects"]>([]);
  const [project, setProject] = useState("");
  const [agent, setAgent] = useState("");
  const [instructions, setInstructions] = useState("");
  const [mode, setMode] = useState("read-only");
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    fetchDispatchOptions()
      .then((o) => {
        if (!active) return;
        setOptions(o.projects);
        if (o.projects[0]) {
          setProject(o.projects[0].project);
          setAgent(o.projects[0].agents[0] ?? "");
        }
      })
      .catch((e) => active && setError((e as Error).message));
    return () => { active = false; };
  }, []);

  const agents = options.find((p) => p.project === project)?.agents ?? [];

  const onProjectChange = (value: string) => {
    setProject(value);
    const next = options.find((p) => p.project === value)?.agents ?? [];
    setAgent(next[0] ?? "");
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setOkMsg(null);
    setBusy(true);
    try {
      const body =
        mode === "workspace-write-verify"
          ? { project, agent, instructions, sandbox: "workspace-write", self_verify: true }
          : { project, agent, instructions, sandbox: mode };
      const { id } = await createTask(body);
      setInstructions("");
      setOkMsg(`Despachado: ${id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="es-form" style={{ marginBottom: 24 }}>
      <h4 className="es-section__title" style={{ marginTop: 0 }}>Nueva tarea</h4>
      {error && <div className="es-banner es-banner--danger">{error}</div>}
      {okMsg && <div className="es-banner es-banner--ok">{okMsg}</div>}
      <div className="es-form__row">
        <select className="es-select" aria-label="Proyecto" value={project} onChange={(e) => onProjectChange(e.target.value)}>
          {options.map((p) => <option key={p.project} value={p.project}>{p.project}</option>)}
        </select>
        <select className="es-select" aria-label="Agente" value={agent} onChange={(e) => setAgent(e.target.value)}>
          {agents.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select className="es-select" aria-label="Modo" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="read-only">Analizar (read-only)</option>
          <option value="workspace-write">Implementar (workspace-write)</option>
          <option value="workspace-write-verify">Implementar + auto-fix (verify)</option>
        </select>
      </div>
      <textarea
        className="es-textarea"
        name="instructions"
        placeholder="Instrucciones para el agente…"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        rows={3}
      />
      <button type="submit" className="es-btn" disabled={busy || !project || !agent || !instructions.trim()}>
        {busy ? "Despachando…" : "Despachar"}
      </button>
    </form>
  );
}
