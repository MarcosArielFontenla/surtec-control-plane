import { useState } from "react";
import { emptyProjectProfile, type ProjectLifecycle, type ProjectProfile } from "../../../../lib/portfolio-profile";
import { saveProjectProfile } from "../api";

const LIFECYCLES: { value: ProjectLifecycle; label: string }[] = [
  { value: "idea", label: "Idea" },
  { value: "discovery", label: "Descubrimiento" },
  { value: "active", label: "Activo" },
  { value: "maintenance", label: "Mantenimiento" },
  { value: "paused", label: "Pausado" },
  { value: "archived", label: "Archivado" },
];

const LIFECYCLE_LABEL = Object.fromEntries(LIFECYCLES.map((item) => [item.value, item.label]));
const CRITICALITY_LABEL: Record<ProjectProfile["criticality"], string> = { low: "Baja", medium: "Media", high: "Alta" };

export function ProjectProfileEditor({
  projectId,
  profile,
  onSaved,
  ready = true,
  loading = false,
}: {
  projectId: string;
  profile?: ProjectProfile;
  onSaved: (profile: ProjectProfile) => void;
  ready?: boolean;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ProjectProfile>(() => profile ?? emptyProjectProfile(projectId));
  const [tagText, setTagText] = useState(() => profile?.tags.join(", ") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const prefix = `profile-${projectId}`;

  const startEditing = () => {
    setDraft(profile ? { ...profile, tags: [...profile.tags] } : emptyProjectProfile(projectId));
    setTagText(profile?.tags.join(", ") ?? "");
    setError(null);
    setSaved(false);
    setOpen(true);
  };

  const update = <K extends keyof ProjectProfile>(key: K, value: ProjectProfile[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    const profileToSave: ProjectProfile = {
      ...draft,
      project_id: projectId,
      current_goal: draft.current_goal?.trim() || null,
      next_action: draft.next_action?.trim() || null,
      deadline: draft.deadline || null,
      client_id: draft.kind === "client" ? draft.client_id?.trim() || null : null,
      last_reviewed_at: draft.last_reviewed_at || null,
      tags: [...new Set(tagText.split(",").map((tag) => tag.trim()).filter(Boolean))],
    };
    try {
      const result = await saveProjectProfile(profileToSave);
      onSaved(result.profile);
      setDraft(result.profile);
      setTagText(result.profile.tags.join(", "));
      setSaved(true);
      setOpen(false);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="profile-editor" aria-label={`Perfil operativo local de ${projectId}`}>
      <div className="profile-editor__summary">
        <div>
          <span className="profile-editor__eyebrow">PERFIL OPERATIVO · LOCAL</span>
          {profile ? (
            <>
              <p className="profile-editor__meta">
                {profile.kind === "client" ? "Cliente" : "Personal"} · {LIFECYCLE_LABEL[profile.lifecycle]} · prioridad {profile.priority}/5 · criticidad {CRITICALITY_LABEL[profile.criticality]}
                {profile.deadline ? ` · vence ${profile.deadline}` : ""}
              </p>
              {profile.current_goal && <p className="profile-editor__goal">{profile.current_goal}</p>}
              {profile.next_action && <p className="profile-editor__next"><b>Siguiente:</b> {profile.next_action}</p>}
              {profile.tags.length > 0 && <p className="profile-editor__tags">{profile.tags.map((tag) => <span key={tag}>{tag}</span>)}</p>}
            </>
          ) : <p className="profile-editor__meta">Sin perfil guardado; el proyecto sigue funcionando normalmente.</p>}
        </div>
        <button
          type="button"
          className="profile-editor__toggle"
          aria-expanded={open}
          aria-controls={open ? `${prefix}-form` : undefined}
          disabled={!ready || busy}
          onClick={startEditing}
        >
          {loading ? "Cargando perfil…" : ready ? (profile ? "Editar perfil" : "Completar perfil") : "Perfil no disponible"}
        </button>
      </div>

      {saved && <p className="profile-editor__success" role="status">Guardado solo en el estado local.</p>}
      {error && !open && <p className="profile-editor__error" role="alert">{error}</p>}

      {open && (
        <form id={`${prefix}-form`} className="profile-editor__form" onSubmit={save}>
          <div className="profile-editor__notice">Contexto operativo local. No modifica `registry/projects.yml` ni se incluye en Git.</div>
          <div className="profile-editor__grid">
            <label htmlFor={`${prefix}-kind`}>Clasificación
              <select id={`${prefix}-kind`} value={draft.kind} disabled={busy} onChange={(event) => update("kind", event.target.value as ProjectProfile["kind"])}>
                <option value="personal">Personal</option>
                <option value="client">Cliente</option>
              </select>
            </label>
            <label htmlFor={`${prefix}-lifecycle`}>Ciclo de vida
              <select id={`${prefix}-lifecycle`} value={draft.lifecycle} disabled={busy} onChange={(event) => update("lifecycle", event.target.value as ProjectLifecycle)}>
                {LIFECYCLES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <label htmlFor={`${prefix}-priority`}>Prioridad (1 = más alta)
              <select id={`${prefix}-priority`} value={draft.priority} disabled={busy} onChange={(event) => update("priority", Number(event.target.value))}>
                {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label htmlFor={`${prefix}-criticality`}>Criticidad
              <select id={`${prefix}-criticality`} value={draft.criticality} disabled={busy} onChange={(event) => update("criticality", event.target.value as ProjectProfile["criticality"])}>
                <option value="low">Baja</option>
                <option value="medium">Media</option>
                <option value="high">Alta</option>
              </select>
            </label>
            {draft.kind === "client" && (
              <label htmlFor={`${prefix}-client-id`} className="profile-editor__wide">ID de cliente (referencia opaca)
                <input id={`${prefix}-client-id`} className="input" maxLength={100} value={draft.client_id ?? ""} disabled={busy} placeholder="client-example" onChange={(event) => update("client_id", event.target.value || null)} />
              </label>
            )}
            <label htmlFor={`${prefix}-goal`} className="profile-editor__wide">Objetivo actual
              <textarea id={`${prefix}-goal`} maxLength={500} rows={2} value={draft.current_goal ?? ""} disabled={busy} onChange={(event) => update("current_goal", event.target.value || null)} />
            </label>
            <label htmlFor={`${prefix}-next`} className="profile-editor__wide">Próxima acción
              <textarea id={`${prefix}-next`} maxLength={300} rows={2} value={draft.next_action ?? ""} disabled={busy} onChange={(event) => update("next_action", event.target.value || null)} />
            </label>
            <label htmlFor={`${prefix}-deadline`}>Fecha límite
              <input id={`${prefix}-deadline`} type="date" value={draft.deadline ?? ""} disabled={busy} onChange={(event) => update("deadline", event.target.value || null)} />
            </label>
            <label htmlFor={`${prefix}-reviewed`}>Última revisión
              <input id={`${prefix}-reviewed`} type="date" value={draft.last_reviewed_at ?? ""} disabled={busy} onChange={(event) => update("last_reviewed_at", event.target.value || null)} />
            </label>
            <label htmlFor={`${prefix}-tags`} className="profile-editor__wide">Etiquetas (separadas por coma)
              <input id={`${prefix}-tags`} className="input" maxLength={900} value={tagText} disabled={busy} placeholder="producto, urgente" onChange={(event) => setTagText(event.target.value)} />
            </label>
          </div>
          {error && <p className="profile-editor__error" role="alert">{error}</p>}
          <div className="profile-editor__actions">
            <button type="submit" className="ibtn primary" disabled={busy || !ready}>{busy ? "Guardando…" : "Guardar perfil local"}</button>
            <button type="button" className="ibtn" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>Cancelar</button>
          </div>
        </form>
      )}
    </section>
  );
}
