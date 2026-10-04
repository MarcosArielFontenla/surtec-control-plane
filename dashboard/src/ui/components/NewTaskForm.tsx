import { useEffect, useState } from "react";
import { Zap, Send } from "lucide-react";
import type { ClientContextCategory, ClientContextOptions } from "../../../../lib/client-portfolio";
import { fetchDispatchOptions, createTask, getClientContextOptions, getContextRoles, type ContextRole, type DispatchMode, type DispatchOptions } from "../api";
import { BulkSync } from "./BulkSync";
import { ClientContextConsent, ContextPreview, contextDisplayText, useContextPreview } from "./ContextPreview";

const MODE_LABELS: Record<DispatchMode, string> = {
  "read-only": "Analizar (read-only)",
  "workspace-write": "Implementar (workspace-write)",
  "workspace-write-verify": "Implementar + auto-fix (verify)",
};

export function NewTaskForm({ bulkProjectIds, initialProject, initialInstructions, onPrefillConsumed }: {
  bulkProjectIds: string[];
  initialProject?: string;
  initialInstructions?: string;
  onPrefillConsumed?: () => void;
}) {
  const [options, setOptions] = useState<DispatchOptions["projects"]>([]);
  const [project, setProject] = useState("");
  const [agent, setAgent] = useState("");
  const [instructions, setInstructions] = useState("");
  const [mode, setMode] = useState<DispatchMode | "">("");
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [contextOptions, setContextOptions] = useState<ClientContextOptions | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [contextCategories, setContextCategories] = useState<ClientContextCategory[]>([]);
  const [profiles, setProfiles] = useState<{ project: string; roles: ContextRole[] } | null>(null);
  const [roleId, setRoleId] = useState("");
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchDispatchOptions()
      .then((o) => {
        if (!active) return;
        setOptions(o.projects);
        const preferredProject = o.projects.find((candidate) => candidate.project === initialProject) ?? o.projects[0];
        if (preferredProject) {
          setProject(preferredProject.project);
          setAgent(preferredProject.agents[0]?.agent ?? "");
          setMode(preferredProject.agents[0]?.modes.find((candidate) => candidate.mode === "read-only" && candidate.allowed)?.mode ?? "");
        }
        if (initialInstructions) setInstructions(initialInstructions);
        if (initialProject || initialInstructions) onPrefillConsumed?.();
      })
      .catch((e) => active && setError((e as Error).message));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setContextOptions(null);
    setContextCategories([]);
    setContextError(null);
    if (!project) return () => { active = false; };
    getClientContextOptions(project)
      .then((options) => { if (active) setContextOptions(options); })
      .catch((reason) => { if (active) setContextError((reason as Error).message); });
    return () => { active = false; };
  }, [project]);

  const selectedProject = options.find((p) => p.project === project);
  const roles = profiles?.project === project ? profiles.roles : [];
  const selectedRole = roles.find((role) => role.id === roleId);
  const agents = (selectedProject?.agents ?? []).filter((candidate) => selectedRole?.agents.includes(candidate.agent) && candidate.allowed_modes.includes("read-only"));
  const selectedAgent = agents.find((candidate) => candidate.agent === agent);
  const selectedMode = selectedAgent?.modes.find((candidate) => candidate.mode === mode);
  const unavailableModes = selectedAgent?.modes.filter((candidate) => !candidate.allowed) ?? [];

  useEffect(() => {
    let active = true;
    setProfiles(null); setRoleId(""); setProfileError(null);
    if (!project) return () => { active = false; };
    getContextRoles(project).then(({ roles: available }) => {
      if (!active) return;
      const allowed = available.filter((role) => role.agents.some((id) => selectedProject?.agents.some((candidate) => candidate.agent === id && candidate.allowed_modes.includes("read-only"))));
      const preferred = allowed.find((role) => role.sandbox_ceiling === "read-only") ?? allowed[0];
      setProfiles({ project, roles: allowed });
      setRoleId(preferred?.id ?? "");
      setAgent(preferred?.agents.find((id) => selectedProject?.agents.some((candidate) => candidate.agent === id && candidate.allowed_modes.includes("read-only"))) ?? "");
      setMode("read-only");
    }).catch((reason) => { if (active) setProfileError(contextDisplayText((reason as Error).message)); });
    return () => { active = false; };
  }, [project, selectedProject]);

  const context = useContextPreview(project && selectedRole && selectedAgent && mode === "read-only" && selectedMode?.allowed && instructions.trim() ? {
    kind: "analysis", project, agent, role_id: roleId, instructions, client_context_categories: contextCategories,
  } : null);

  const onProjectChange = (value: string) => {
    setProject(value);
    setContextCategories([]);
    const next = options.find((p) => p.project === value)?.agents[0];
    setAgent(next?.agent ?? "");
    setMode(next?.modes.find((candidate) => candidate.mode === "read-only" && candidate.allowed)?.mode ?? "");
  };

  const onAgentChange = (value: string) => {
    setAgent(value);
    setContextCategories([]);
    setMode(agents.find((candidate) => candidate.agent === value)?.modes.find((candidate) => candidate.mode === "read-only" && candidate.allowed)?.mode ?? "");
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !context.preview?.allowed || mode !== "read-only") return;
    setError(null);
    setOkMsg(null);
    setBusy(true);
    try {
      const { id } = await createTask({ project, agent, instructions, sandbox: "read-only", role_id: roleId,
        preview_fingerprint: context.preview.fingerprint, client_context_categories: contextCategories });
      setInstructions("");
      setContextCategories([]);
      setOkMsg(`Despachado: ${id}`);
    } catch (err) {
      setError(contextDisplayText((err as Error).message));
    } finally {
      context.clearPreview();
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
      <div className="organization-form-grid">
        <div className="field">
          <label>Repositorio</label>
          <select aria-label="Proyecto" value={project} disabled={busy} onChange={(e) => onProjectChange(e.target.value)}>
            {options.map((p) => <option key={p.project} value={p.project}>{p.project}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="analysis-profile">Perfil Codex</label>
          <select id="analysis-profile" value={roleId} disabled={busy || roles.length === 0} onChange={(event) => {
            setRoleId(event.target.value); setContextCategories([]);
            setAgent(roles.find((role) => role.id === event.target.value)?.agents.find((id) => selectedProject?.agents.some((candidate) => candidate.agent === id && candidate.allowed_modes.includes("read-only"))) ?? "");
          }}>
            <option value="" disabled>Seleccionar perfil de análisis</option>
            {roles.map((role) => <option key={role.id} value={role.id}>{role.display_name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Agente</label>
          <select aria-label="Agente" value={agent} onChange={(e) => onAgentChange(e.target.value)} disabled={busy || agents.length === 0}>
            {agents.map((candidate) => <option key={candidate.agent} value={candidate.agent}>{candidate.agent}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Modo</label>
          <select aria-label="Modo" value={mode} onChange={(e) => { setMode(e.target.value as DispatchMode); setContextCategories([]); }} disabled={busy || !selectedAgent || selectedAgent.allowed_modes.length === 0}>
            {selectedAgent?.modes.map((candidate) => (
              <option key={candidate.mode} value={candidate.mode} disabled={!candidate.allowed || candidate.mode !== "read-only"}>
                {MODE_LABELS[candidate.mode]}{candidate.mode === "read-only" ? (candidate.allowed ? "" : " (no disponible)") : " (crear desde Issues)"}
              </option>
            ))}
          </select>
        </div>
      </div>
      {selectedRole && <p className="work-issue-note">{contextDisplayText(selectedRole.responsibility)} Seleccionar un perfil no amplía permisos; el preview valida la política actual.</p>}
      {profileError && <div className="banner banner--warn" role="alert">No se pudieron cargar los perfiles ({profileError}).</div>}
      {profiles?.project === project && roles.length === 0 && <p role="status">No hay perfiles de análisis disponibles para este checkout y su política.</p>}
      {selectedAgent && (
        <div className="banner" role="note">
          Para implementar, creá y autorizá un issue local desde Issues; este formulario queda reservado al análisis read-only.
        </div>
      )}
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
      <ClientContextConsent options={contextOptions} categories={contextCategories} onChange={setContextCategories} disabled={busy} error={contextError} />
      <textarea name="instructions" aria-label="Instrucciones" maxLength={20000} disabled={busy} placeholder="Instrucciones para el agente…" value={instructions} onChange={(e) => { setInstructions(e.target.value); setContextCategories([]); }} />
      {context.error && <div className="banner banner--warn" role="alert">{context.error}</div>}
      {context.preview && <ContextPreview preview={context.preview} />}
      {!context.preview && <p className="work-issue-note">Antes de despachar, generá y revisá el preview. Cambiar el pedido, el perfil o el consentimiento invalida el preview anterior.</p>}
      <div className="actions organization-form-actions">
        <button type="button" className="ibtn" disabled={busy || context.pending || !selectedRole || !selectedAgent || mode !== "read-only" || !selectedMode?.allowed || !instructions.trim()} onClick={() => void context.requestPreview()}>
          {context.pending ? "Previsualizando…" : "Previsualizar contexto"}
        </button>
        <button type="submit" className="ibtn primary" disabled={busy || context.pending || !context.preview?.allowed}>
          <Send /> {busy ? "Despachando…" : "Despachar"}
        </button>
      </div>
    </form>
  );
}
