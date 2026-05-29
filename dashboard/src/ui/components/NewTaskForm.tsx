import { useEffect, useState } from "react";
import { fetchDispatchOptions, createTask, type DispatchOptions } from "../api";

export function NewTaskForm() {
  const [options, setOptions] = useState<DispatchOptions["projects"]>([]);
  const [project, setProject] = useState("");
  const [agent, setAgent] = useState("");
  const [instructions, setInstructions] = useState("");
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
      const { id } = await createTask({ project, agent, instructions });
      setInstructions("");
      setOkMsg(`Despachado: ${id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, marginBottom: 24 }}>
      <h4 style={{ marginTop: 0 }}>Nueva tarea</h4>
      {error && <div style={{ background: "#f8d7da", padding: 6, borderRadius: 6, marginBottom: 8 }}>{error}</div>}
      {okMsg && <div style={{ background: "#d1e7dd", padding: 6, borderRadius: 6, marginBottom: 8 }}>{okMsg}</div>}
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <select aria-label="Proyecto" value={project} onChange={(e) => onProjectChange(e.target.value)}>
          {options.map((p) => <option key={p.project} value={p.project}>{p.project}</option>)}
        </select>
        <select aria-label="Agente" value={agent} onChange={(e) => setAgent(e.target.value)}>
          {agents.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      <textarea
        name="instructions"
        placeholder="Instrucciones para el agente…"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        rows={3}
        style={{ width: "100%", boxSizing: "border-box", marginBottom: 8 }}
      />
      <button type="submit" disabled={busy || !project || !agent || !instructions.trim()}>
        {busy ? "Despachando…" : "Despachar"}
      </button>
    </form>
  );
}
