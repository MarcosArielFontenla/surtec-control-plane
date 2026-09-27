import { useEffect, useState } from "react";
import { Zap, Send } from "lucide-react";
import { fetchDispatchOptions, createTask, type DispatchMode, type DispatchOptions } from "../api";
import { BulkSync } from "./BulkSync";

const MODE_LABELS: Record<DispatchMode, string> = {
  "read-only": "Analizar (read-only)",
  "workspace-write": "Implementar (workspace-write)",
  "workspace-write-verify": "Implementar + auto-fix (verify)",
};

export function NewTaskForm({ bulkProjectIds }: { bulkProjectIds: string[] }) {
  const [options, setOptions] = useState<DispatchOptions["projects"]>([]);
  const [project, setProject] = useState("");
  const [agent, setAgent] = useState("");
  const [instructions, setInstructions] = useState("");
  const [mode, setMode] = useState<DispatchMode | "">("");
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
          setAgent(o.projects[0].agents[0]?.agent ?? "");
          setMode(o.projects[0].agents[0]?.default_mode ?? "");
        }
      })
      .catch((e) => active && setError((e as Error).message));
    return () => { active = false; };
  }, []);

  const selectedProject = options.find((p) => p.project === project);
  const agents = selectedProject?.agents ?? [];
  const selectedAgent = agents.find((candidate) => candidate.agent === agent);
  const selectedMode = selectedAgent?.modes.find((candidate) => candidate.mode === mode);
  const unavailableModes = selectedAgent?.modes.filter((candidate) => !candidate.allowed) ?? [];

  const onProjectChange = (value: string) => {
    setProject(value);
    const next = options.find((p) => p.project === value)?.agents[0];
    setAgent(next?.agent ?? "");
    setMode(next?.default_mode ?? "");
  };

  const onAgentChange = (value: string) => {
    setAgent(value);
    setMode(agents.find((candidate) => candidate.agent === value)?.default_mode ?? "");
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
    <form onSubmit={onSubmit} className="panel task-panel">
      <div className="task-head">
        <div className="ttl"><Zap /> Nueva tarea</div>
        <BulkSync projectIds={bulkProjectIds} />
      </div>
      {error && <div className="banner banner--danger">{error}</div>}
      {okMsg && <div className="banner banner--ok">{okMsg}</div>}
      <div className="task-row">
        <div className="field">
          <label>Repositorio</label>
          <select aria-label="Proyecto" value={project} onChange={(e) => onProjectChange(e.target.value)}>
            {options.map((p) => <option key={p.project} value={p.project}>{p.project}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Agente</label>
          <select aria-label="Agente" value={agent} onChange={(e) => onAgentChange(e.target.value)} disabled={agents.length === 0}>
            {agents.map((candidate) => <option key={candidate.agent} value={candidate.agent}>{candidate.agent}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Modo</label>
          <select aria-label="Modo" value={mode} onChange={(e) => setMode(e.target.value as DispatchMode)} disabled={!selectedAgent || selectedAgent.allowed_modes.length === 0}>
            {selectedAgent?.modes.map((candidate) => (
              <option key={candidate.mode} value={candidate.mode} disabled={!candidate.allowed}>
                {MODE_LABELS[candidate.mode]}{candidate.allowed ? "" : " (no disponible)"}
              </option>
            ))}
          </select>
        </div>
      </div>
      {selectedAgent && unavailableModes.length > 0 && (
        <div className="banner" role="note">
          Modos no disponibles: {unavailableModes.map((candidate) => `${MODE_LABELS[candidate.mode]} — ${candidate.reason ?? "no permitido por política"}`).join(" · ")}
        </div>
      )}
      {selectedProject && !selectedProject.has_local_checkout && (
        <div className="banner" role="status">Este proyecto no tiene un checkout local contenido; no se puede despachar.</div>
      )}
      {selectedProject && agents.length === 0 && (
        <div className="banner" role="status">Este proyecto no tiene agentes autorizados para despachar.</div>
      )}
      <div className="task-foot">
        <textarea name="instructions" placeholder="Instrucciones para el agente…" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        <button type="submit" className="cta" disabled={busy || !project || !agent || !selectedMode?.allowed || !instructions.trim()}>
          <Send /> {busy ? "Despachando…" : "Despachar"}
        </button>
      </div>
    </form>
  );
}
