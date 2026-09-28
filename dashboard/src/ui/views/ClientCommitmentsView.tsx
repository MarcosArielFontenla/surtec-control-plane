import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Plus, Save } from "lucide-react";
import type { ClientCommitment, ClientRecord, ClientSummary } from "../../../../lib/client-portfolio";
import type { ProjectView } from "../../../../lib/state/types";
import { getClient, getClients, getCommitments, saveClient, saveCommitment } from "../api";

type ClientDraft = Omit<ClientRecord, "id" | "created_at" | "updated_at">;
type CommitmentDraft = Omit<ClientCommitment, "id" | "created_at" | "updated_at">;

const blankClient = (): ClientDraft => ({
  display_name: "",
  status: "active",
  criticality: "medium",
  sla_note: null,
  next_review_date: null,
  confidential_notes: null,
});

const blankCommitment = (projectId: string): CommitmentDraft => ({
  project_id: projectId,
  client_id: null,
  title: "",
  expected_outcome: "",
  due_date: null,
  priority: 3,
  criticality: "medium",
  state: "planned",
  issue_numbers: [],
  pull_request_numbers: [],
  task_ids: [],
  session_ids: [],
  next_action: "",
});

function listOfIds(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function listOfNumbers(value: string): number[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean).map(Number))];
}

function showIds(values: Array<string | number>): string {
  return values.join(", ");
}

const STATE_LABEL: Record<ClientCommitment["state"], string> = {
  planned: "Planificado",
  "in-progress": "En curso",
  blocked: "Bloqueado",
  completed: "Completado",
  cancelled: "Cancelado",
};

export function ClientCommitmentsView({ projects }: { projects: ProjectView[] }) {
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [commitments, setCommitments] = useState<ClientCommitment[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [clientDraft, setClientDraft] = useState<ClientDraft>(blankClient);
  const [editingCommitment, setEditingCommitment] = useState<ClientCommitment | null>(null);
  const [commitmentDraft, setCommitmentDraft] = useState<CommitmentDraft>(() => blankCommitment(projects[0]?.id ?? ""));
  const [masked, setMasked] = useState(true);
  const [loading, setLoading] = useState(true);
  const [savingClient, setSavingClient] = useState(false);
  const [savingCommitment, setSavingCommitment] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [clientResult, commitmentResult] = await Promise.all([getClients(), getCommitments()]);
    setClients(clientResult.clients);
    setCommitments(commitmentResult.commitments);
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([getClients(), getCommitments()])
      .then(([clientResult, commitmentResult]) => {
        if (!active) return;
        setClients(clientResult.clients);
        setCommitments(commitmentResult.commitments);
        setError(null);
      })
      .catch((reason) => { if (active) setError((reason as Error).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const clientNames = useMemo(() => new Map(clients.map((client) => [client.id, client.display_name])), [clients]);
  const commitmentClients = clients.filter((client) => client.project_ids.includes(commitmentDraft.project_id));

  const selectClient = async (id: string) => {
    setSelectedClientId(id || null);
    setError(null);
    setSuccess(null);
    if (!id) {
      setClientDraft(blankClient());
      return;
    }
    try {
      const result = await getClient(id);
      setClientDraft({
        display_name: result.client.display_name,
        status: result.client.status,
        criticality: result.client.criticality,
        sla_note: result.client.sla_note,
        next_review_date: result.client.next_review_date,
        confidential_notes: result.client.confidential_notes,
      });
    } catch (reason) { setError((reason as Error).message); }
  };

  const saveClientForm = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSavingClient(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await saveClient(clientDraft, selectedClientId ?? undefined);
      setSelectedClientId(result.client.id);
      setClientDraft({
        display_name: result.client.display_name,
        status: result.client.status,
        criticality: result.client.criticality,
        sla_note: result.client.sla_note,
        next_review_date: result.client.next_review_date,
        confidential_notes: result.client.confidential_notes,
      });
      await refresh();
      setSuccess("Cliente guardado únicamente en el estado local.");
    } catch (reason) { setError((reason as Error).message); }
    finally { setSavingClient(false); }
  };

  const startNewCommitment = () => {
    setEditingCommitment(null);
    setCommitmentDraft(blankCommitment(projects[0]?.id ?? ""));
    setError(null);
    setSuccess(null);
  };

  const editCommitment = (item: ClientCommitment) => {
    setEditingCommitment(item);
    setCommitmentDraft({
      project_id: item.project_id,
      client_id: item.client_id,
      title: item.title,
      expected_outcome: item.expected_outcome,
      due_date: item.due_date,
      priority: item.priority,
      criticality: item.criticality,
      state: item.state,
      issue_numbers: [...item.issue_numbers],
      pull_request_numbers: [...item.pull_request_numbers],
      task_ids: [...item.task_ids],
      session_ids: [...item.session_ids],
      next_action: item.next_action,
    });
    setError(null);
    setSuccess(null);
  };

  const saveCommitmentForm = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSavingCommitment(true);
    setError(null);
    setSuccess(null);
    try {
      await saveCommitment(commitmentDraft, editingCommitment?.id);
      await refresh();
      setSuccess("Compromiso guardado y disponible para el ranking de Hoy.");
      startNewCommitment();
    } catch (reason) { setError((reason as Error).message); }
    finally { setSavingCommitment(false); }
  };

  const updateCommitment = <K extends keyof CommitmentDraft>(key: K, value: CommitmentDraft[K]) => {
    setCommitmentDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="client-portfolio-view">
      <section className="client-portfolio-hero panel">
        <div>
          <span className="section-label">OPERACIÓN DE SOFTWARE · LOCAL</span>
          <h2>Clientes y compromisos</h2>
          <p>Contexto de entrega acotado; no es un CRM. Los datos sensibles permanecen en el estado local.</p>
        </div>
        <button type="button" className="ibtn" aria-pressed={masked} onClick={() => setMasked((value) => !value)}>
          {masked ? <Eye size={15} /> : <EyeOff size={15} />}
          {masked ? "Mostrar nombres" : "Ocultar nombres"}
        </button>
      </section>

      {error && <div className="banner banner--danger" role="alert">{error}</div>}
      {success && <div className="banner banner--ok" role="status">{success}</div>}
      {loading ? <p className="empty-mini">Cargando directorio local…</p> : (
        <div className="client-portfolio-grid">
          <section className="client-portfolio-card panel">
            <div className="section-head">
              <div><span className="section-label">DIRECTORIO ACOTADO</span><h2>Clientes</h2></div>
              <button type="button" className="ghost-btn" onClick={() => void selectClient("")}><Plus size={14} /> Nuevo</button>
            </div>
            <p className="client-portfolio-note">La relación con repositorios se deriva de Perfil operativo → Cliente asociado en el detalle del proyecto.</p>
            {clients.length === 0 ? <p className="empty-mini">Todavía no hay clientes locales. Los proyectos personales no necesitan registros ficticios.</p> : (
              <div className="client-list">
                {clients.map((client, index) => (
                  <button type="button" key={client.id} className={"client-row" + (selectedClientId === client.id ? " client-row--selected" : "")} onClick={() => void selectClient(client.id)}>
                    <span className="client-row__main"><b>{masked ? "Cliente " + (index + 1) : client.display_name}</b>
                      <small>{client.status === "active" ? "Activo" : "Pausado"} · {client.project_ids.length} proyectos · {client.active_commitment_count} compromisos activos</small></span>
                    <span className={"client-state client-state--" + client.status}>{client.status === "active" ? "Activo" : "Pausado"}</span>
                  </button>
                ))}
              </div>
            )}

            <form className="client-form" onSubmit={saveClientForm}>
              <div className="section-head"><h3>{selectedClientId ? "Editar registro local" : "Nuevo cliente"}</h3></div>
              <label>Nombre visible
                <input className="input" required maxLength={120} value={clientDraft.display_name}
                  onChange={(event) => setClientDraft((current) => ({ ...current, display_name: event.target.value }))} />
              </label>
              <div className="client-form__row">
                <label>Estado
                  <select value={clientDraft.status} onChange={(event) => setClientDraft((current) => ({ ...current, status: event.target.value as ClientDraft["status"] }))}>
                    <option value="active">Activo</option><option value="paused">Pausado</option>
                  </select>
                </label>
                <label>Criticidad operativa
                  <select value={clientDraft.criticality} onChange={(event) => setClientDraft((current) => ({ ...current, criticality: event.target.value as ClientDraft["criticality"] }))}>
                    <option value="low">Baja</option><option value="medium">Media</option><option value="high">Alta</option>
                  </select>
                </label>
              </div>
              <label>Nota de SLA / criticidad
                <textarea rows={2} maxLength={500} value={clientDraft.sla_note ?? ""}
                  onChange={(event) => setClientDraft((current) => ({ ...current, sla_note: event.target.value || null }))} />
              </label>
              <label>Próxima revisión
                <input type="date" value={clientDraft.next_review_date ?? ""}
                  onChange={(event) => setClientDraft((current) => ({ ...current, next_review_date: event.target.value || null }))} />
              </label>
              <label>Notas confidenciales
                <textarea rows={4} maxLength={2000} value={clientDraft.confidential_notes ?? ""}
                  onChange={(event) => setClientDraft((current) => ({ ...current, confidential_notes: event.target.value || null }))} />
              </label>
              <p className="client-confidential-notice">Confidencial · solo local · nunca se incluye automáticamente en instrucciones de Codex. Compartir notas requiere selección explícita en el formulario de tarea.</p>
              <button type="submit" className="ibtn primary" disabled={savingClient || !clientDraft.display_name.trim()}><Save size={14} /> {savingClient ? "Guardando…" : "Guardar cliente"}</button>
            </form>
          </section>

          <section className="client-portfolio-card panel">
            <div className="section-head">
              <div><span className="section-label">RESULTADOS ESPERADOS</span><h2>Compromisos de entrega</h2></div>
              <button type="button" className="ghost-btn" onClick={startNewCommitment}><Plus size={14} /> Nuevo</button>
            </div>
            {commitments.length === 0 ? <p className="empty-mini">Sin compromisos registrados.</p> : (
              <div className="commitment-list">
                {commitments.map((item) => (
                  <button type="button" className="commitment-row" key={item.id} onClick={() => editCommitment(item)}>
                    <span className="commitment-row__main"><b>{item.title}</b>
                      <small>{item.project_id} · {item.client_id ? (masked ? "Cliente oculto" : clientNames.get(item.client_id) ?? "Cliente sin registro") : "Proyecto personal"} · vence {item.due_date ?? "sin fecha"}</small>
                      <small>Siguiente: {item.next_action}</small></span>
                    <span className={"client-state client-state--" + item.state}>{STATE_LABEL[item.state]}</span>
                  </button>
                ))}
              </div>
            )}

            <form className="client-form" onSubmit={saveCommitmentForm}>
              <div className="section-head"><h3>{editingCommitment ? "Editar compromiso" : "Nuevo compromiso"}</h3></div>
              <label>Proyecto
                <select required value={commitmentDraft.project_id} onChange={(event) => {
                  const project_id = event.target.value;
                  updateCommitment("project_id", project_id);
                  if (!clients.some((client) => client.id === commitmentDraft.client_id && client.project_ids.includes(project_id))) updateCommitment("client_id", null);
                }}>
                  <option value="">Seleccionar proyecto</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.id}</option>)}
                </select>
              </label>
              <label>Cliente (opcional)
                <select value={commitmentDraft.client_id ?? ""} onChange={(event) => updateCommitment("client_id", event.target.value || null)}>
                  <option value="">Sin cliente / proyecto personal</option>
                  {commitmentClients.map((client) => <option key={client.id} value={client.id}>{masked ? "Cliente oculto" : client.display_name}</option>)}
                </select>
              </label>
              <label>Hito / entregable
                <input className="input" required maxLength={160} value={commitmentDraft.title}
                  onChange={(event) => updateCommitment("title", event.target.value)} />
              </label>
              <label>Resultado esperado
                <textarea required rows={2} maxLength={800} value={commitmentDraft.expected_outcome}
                  onChange={(event) => updateCommitment("expected_outcome", event.target.value)} />
              </label>
              <div className="client-form__row">
                <label>Fecha límite
                  <input type="date" value={commitmentDraft.due_date ?? ""} onChange={(event) => updateCommitment("due_date", event.target.value || null)} />
                </label>
                <label>Prioridad (1 = más alta)
                  <select value={commitmentDraft.priority} onChange={(event) => updateCommitment("priority", Number(event.target.value))}>
                    {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
              </div>
              <div className="client-form__row">
                <label>Criticidad
                  <select value={commitmentDraft.criticality} onChange={(event) => updateCommitment("criticality", event.target.value as CommitmentDraft["criticality"])}>
                    <option value="low">Baja</option><option value="medium">Media</option><option value="high">Alta</option>
                  </select>
                </label>
                <label>Estado
                  <select value={commitmentDraft.state} onChange={(event) => updateCommitment("state", event.target.value as CommitmentDraft["state"])}>
                    {Object.entries(STATE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
              </div>
              <label>Próxima acción explícita
                <textarea required rows={2} maxLength={500} value={commitmentDraft.next_action}
                  onChange={(event) => updateCommitment("next_action", event.target.value)} />
              </label>
              <details className="client-link-fields">
                <summary>Vincular evidencia existente</summary>
                <label>Números de issues (separados por coma)
                  <input className="input" value={showIds(commitmentDraft.issue_numbers)} onChange={(event) => updateCommitment("issue_numbers", listOfNumbers(event.target.value))} />
                </label>
                <label>Números de PRs (separados por coma)
                  <input className="input" value={showIds(commitmentDraft.pull_request_numbers)} onChange={(event) => updateCommitment("pull_request_numbers", listOfNumbers(event.target.value))} />
                </label>
                <label>IDs de tareas del mismo proyecto
                  <input className="input" value={showIds(commitmentDraft.task_ids)} onChange={(event) => updateCommitment("task_ids", listOfIds(event.target.value))} />
                </label>
                <label>IDs de sesiones del mismo proyecto
                  <input className="input" value={showIds(commitmentDraft.session_ids)} onChange={(event) => updateCommitment("session_ids", listOfIds(event.target.value))} />
                </label>
              </details>
              <div className="client-form__actions">
                <button type="submit" className="ibtn primary" disabled={savingCommitment || !commitmentDraft.project_id || !commitmentDraft.title.trim() || !commitmentDraft.expected_outcome.trim() || !commitmentDraft.next_action.trim()}>
                  <Save size={14} /> {savingCommitment ? "Guardando…" : "Guardar compromiso"}
                </button>
                {editingCommitment && <button type="button" className="ibtn" onClick={startNewCommitment}>Cancelar edición</button>}
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
