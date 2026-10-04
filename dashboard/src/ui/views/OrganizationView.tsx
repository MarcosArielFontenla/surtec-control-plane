import { useEffect, useState } from "react";
import type { CompanyProfile, Objective, ObjectiveHorizon, ObjectiveStatus, OrganizationSnapshot, ProjectObjectiveLinks } from "../../../../lib/organization";
import type { ProjectView } from "../../../../lib/state/types";
import type { ProjectProfile } from "../../../../lib/portfolio-profile";
import type { SignalFeed } from "../../../../lib/signals/types";
import { createObjective, getOrganization, getSignals, saveCompanyProfile, saveObjective, saveProjectObjectiveLinks } from "../api";

const STATUS_LABEL: Record<ObjectiveStatus, string> = { draft: "Borrador", active: "Activa", paused: "Pausada", achieved: "Lograda", cancelled: "Cancelada" };
const HORIZON_LABEL: Record<ObjectiveHorizon, string> = { now: "Ahora", quarter: "Trimestre", year: "Año", ongoing: "Continuo" };
const emptyLinks: ProjectObjectiveLinks = { objective_ids: [], primary_objective_id: null };

function isStale(date: string | null): boolean {
  return !date || Date.now() - Date.parse(date + "T00:00:00") >= 30 * 24 * 60 * 60 * 1000;
}

function ProjectLinksEditor({ project, profile, objectives, links, onSaved }: {
  project: ProjectView;
  profile?: ProjectProfile;
  objectives: Objective[];
  links: ProjectObjectiveLinks;
  onSaved: (snapshot: OrganizationSnapshot) => void;
}) {
  const [selected, setSelected] = useState(links.objective_ids);
  const [primary, setPrimary] = useState(links.primary_objective_id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setSelected(links.objective_ids); setPrimary(links.primary_objective_id ?? ""); }, [links]);
  const toggle = (id: string, checked: boolean) => {
    const next = checked ? [...selected, id] : selected.filter((item) => item !== id);
    setSelected(next);
    if (!next.includes(primary)) setPrimary("");
  };
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const result = await saveProjectObjectiveLinks(project.id, { objective_ids: selected, primary_objective_id: primary || null });
      onSaved(result.organization);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="organization-project-row">
    <div className="organization-project-title"><b>{project.id}</b><span>{project.status}</span><small>Salud técnica: {project.health ?? "sin evidencia"}</small>
      {profile?.kind === "personal" ? <small>Personal · no requiere objetivo</small> : profile && project.status === "active" && selected.length === 0 ? <small className="organization-gap">Relación estratégica pendiente</small> : null}
    </div>
    <div className="organization-project-links">
      <div className="organization-checkboxes" aria-label={`Objetivos de ${project.id}`}>
        {objectives.map((objective) => <label key={objective.id}><input type="checkbox" checked={selected.includes(objective.id)} disabled={busy} onChange={(event) => toggle(objective.id, event.target.checked)} />{objective.title} · {STATUS_LABEL[objective.status]}</label>)}
      </div>
      <label>Objetivo principal
        <select value={primary} disabled={busy || selected.length === 0} onChange={(event) => setPrimary(event.target.value)}>
          <option value="">Sin principal</option>
          {objectives.filter((objective) => selected.includes(objective.id)).map((objective) => <option key={objective.id} value={objective.id}>{objective.title}</option>)}
        </select>
      </label>
      <button type="button" className="ibtn" disabled={busy} onClick={() => void save()}>{busy ? "Guardando…" : "Guardar vínculos"}</button>
      {error && <span className="organization-error" role="alert">{error}</span>}
    </div>
  </div>;
}

export function OrganizationView({ projects, profiles }: { projects: ProjectView[]; profiles: Record<string, ProjectProfile> }) {
  const [organization, setOrganization] = useState<OrganizationSnapshot | null>(null);
  const [signals, setSignals] = useState<SignalFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [companyDraft, setCompanyDraft] = useState<CompanyProfile | null>(null);
  const [mission, setMission] = useState("");
  const [displayName, setDisplayName] = useState("SURTEC");
  const [principlesText, setPrinciplesText] = useState("");
  const [editing, setEditing] = useState<Objective | null>(null);
  const [title, setTitle] = useState("");
  const [outcome, setOutcome] = useState("");
  const [criteriaText, setCriteriaText] = useState("");
  const [status, setStatus] = useState<ObjectiveStatus>("draft");
  const [horizon, setHorizon] = useState<ObjectiveHorizon>("quarter");
  const [priority, setPriority] = useState(3);
  const [targetDate, setTargetDate] = useState("");
  const [parentId, setParentId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    const result = await getOrganization();
    setOrganization(result);
    setCompanyDraft(result.company);
    setMission(result.company.mission ?? "");
    setDisplayName(result.company.display_name);
    setPrinciplesText(result.company.operating_principles.join("\n"));
    try { setSignals(await getSignals()); } catch { setSignals(null); }
  };
  useEffect(() => { void refresh().catch((reason) => setError((reason as Error).message)); }, []);

  const resetObjective = () => {
    setEditing(null); setTitle(""); setOutcome(""); setCriteriaText(""); setStatus("draft");
    setHorizon("quarter"); setPriority(3); setTargetDate(""); setParentId("");
  };
  const editObjective = (objective: Objective) => {
    setEditing(objective); setTitle(objective.title); setOutcome(objective.desired_outcome);
    setCriteriaText(objective.success_criteria.join("\n")); setStatus(objective.status); setHorizon(objective.horizon);
    setPriority(objective.priority); setTargetDate(objective.target_date ?? ""); setParentId(objective.parent_objective_id ?? "");
    setNotice(null);
  };
  const criteria = () => [...new Set(criteriaText.split("\n").map((item) => item.trim()).filter(Boolean))];
  const submitObjective = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      if (editing) {
        await saveObjective({ ...editing, title: title.trim(), desired_outcome: outcome.trim(), success_criteria: criteria(), status, horizon, priority, target_date: targetDate || null, parent_objective_id: parentId || null });
      } else {
        await createObjective({ title: title.trim(), desired_outcome: outcome.trim(), success_criteria: criteria(), status, horizon, priority, target_date: targetDate || null, parent_objective_id: parentId || null });
      }
      await refresh(); setNotice("Objetivo guardado en el estado local."); resetObjective();
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };
  const submitCompany = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!companyDraft || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await saveCompanyProfile({ ...companyDraft, display_name: displayName.trim(), mission: mission.trim() || null, operating_principles: [...new Set(principlesText.split("\n").map((item) => item.trim()).filter(Boolean))] });
      setCompanyDraft({ ...companyDraft, ...result.company }); setNotice("Perfil SURTEC guardado localmente.");
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };

  if (!organization) return <section className="organization-view panel">{error ? <p role="alert">No se pudo cargar SURTEC: {error}</p> : <p>Cargando SURTEC…</p>}</section>;
  const signalsByProject = new Map<string, SignalFeed["signals"]>();
  for (const signal of signals?.signals ?? []) {
    if (signal.state === "resolved" || signal.severity === "info") continue;
    signalsByProject.set(signal.project_id, [...(signalsByProject.get(signal.project_id) ?? []), signal]);
  }

  return <div className="organization-view">
    <section className="panel organization-company">
      <div className="section-head"><div><span className="organization-kicker">EMPRESA · RAÍZ ESTRATÉGICA</span><h2>{organization.company.display_name}</h2></div><span className="organization-local">Local · una sola empresa</span></div>
      <form onSubmit={submitCompany} className="organization-company-form">
        <label className="organization-company-name">Nombre visible<input maxLength={100} required value={displayName} disabled={busy} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label className="organization-company-mission">Misión<textarea maxLength={800} rows={3} value={mission} disabled={busy} onChange={(event) => setMission(event.target.value)} placeholder="¿Qué cambio busca producir SURTEC?" /></label>
        <label className="organization-company-principles">Principios operativos<textarea maxLength={5000} rows={4} value={principlesText} disabled={busy} onChange={(event) => setPrinciplesText(event.target.value)} placeholder="Un principio por línea" /></label>
        <button className="ibtn primary" type="submit" disabled={busy}>{busy ? "Guardando…" : "Guardar perfil"}</button>
      </form>
      <p className="organization-meta">Última revisión: {organization.company.last_reviewed_at ?? "pendiente"} · Objetivos activos: {organization.company.active_objective_ids.length}</p>
    </section>

    <section className="panel organization-objectives">
      <div className="section-head"><div><span className="organization-kicker">ESTRATEGIA</span><h2>Objetivos</h2></div><span className="meta">{organization.objectives.length}</span></div>
      {notice && <p className="organization-success" role="status">{notice}</p>}
      {error && <p className="organization-error" role="alert">{error}</p>}
      <div className="organization-objective-grid">
        {organization.objectives.length === 0 ? <p className="empty-mini">Todavía no hay objetivos. Podés empezar por un resultado concreto, sin convertir tus proyectos personales en metas comerciales.</p> : organization.objectives.map((objective) => {
          const signalsForObjective = objective.project_ids.flatMap((id) => signalsByProject.get(id) ?? []);
          const structuralGap = objective.project_ids.length === 0 || objective.success_criteria.length === 0;
          const stale = isStale(objective.last_reviewed_at);
          const health = objective.status === "paused" ? "Pausada" : objective.status === "achieved" ? "Lograda" : objective.status === "cancelled" ? "Cancelada" : structuralGap || stale ? "Requiere revisión" : signalsForObjective.length ? "Atención de proyectos" : "Saludable";
          return <article key={objective.id} className="organization-objective-card">
            <div className="organization-objective-top"><span className={`organization-status organization-status--${objective.status}`}>{STATUS_LABEL[objective.status]}</span><span className="organization-health">{health}</span></div>
            <h3>{objective.title}</h3><p>{objective.desired_outcome}</p>
            <div className="organization-objective-facts"><span>{HORIZON_LABEL[objective.horizon]}</span><span>Prioridad {objective.priority}</span><span>Objetivo: {objective.target_date ?? "sin fecha"}</span></div>
            {objective.success_criteria.length === 0 ? <p className="organization-gap">Faltan criterios de éxito.</p> : <ul>{objective.success_criteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>}
            {objective.project_ids.length === 0 ? <p className="organization-gap">Sin proyectos vinculados.</p> : <p className="organization-linked">Proyectos: {objective.project_ids.map((id) => projects.find((project) => project.id === id)?.id ?? id).join(", ")}</p>}
            <p className="organization-meta">Revisado: {objective.last_reviewed_at ?? "nunca"} · Evidencia de proyectos: {signalsForObjective.length ? `${signalsForObjective.length} señales de atención` : "sin alertas abiertas"}</p>
            <button type="button" className="ibtn" onClick={() => editObjective(objective)}>Editar objetivo</button>
          </article>;
        })}
      </div>

      <form className="organization-objective-form" onSubmit={submitObjective}>
        <h3>{editing ? "Editar objetivo" : "Nuevo objetivo"}</h3>
        <div className="organization-form-grid">
          <label>Título<input maxLength={160} required value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>Resultado deseado<input maxLength={800} required value={outcome} disabled={busy} onChange={(event) => setOutcome(event.target.value)} /></label>
          <label className="organization-form-wide">Criterios de éxito <small>Uno por línea; pueden quedar vacíos mientras esté en borrador.</small><textarea maxLength={5000} rows={3} value={criteriaText} disabled={busy} onChange={(event) => setCriteriaText(event.target.value)} /></label>
          <label>Estado<select value={status} disabled={busy} onChange={(event) => setStatus(event.target.value as ObjectiveStatus)}>{Object.entries(STATUS_LABEL).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label>Horizonte<select value={horizon} disabled={busy} onChange={(event) => setHorizon(event.target.value as ObjectiveHorizon)}>{Object.entries(HORIZON_LABEL).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label>Prioridad<select value={priority} disabled={busy} onChange={(event) => setPriority(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Fecha objetivo<input type="date" value={targetDate} disabled={busy} onChange={(event) => setTargetDate(event.target.value)} /></label>
          <label className="organization-form-wide">Objetivo superior<select value={parentId} disabled={busy} onChange={(event) => setParentId(event.target.value)}><option value="">Sin objetivo superior</option>{organization.objectives.filter((objective) => objective.id !== editing?.id).map((objective) => <option key={objective.id} value={objective.id}>{objective.title}</option>)}</select></label>
        </div>
        {error && <p className="organization-error" role="alert">{error}</p>}
        <div className="organization-form-actions"><button type="submit" className="ibtn primary" disabled={busy}>{busy ? "Guardando…" : editing ? "Guardar cambios" : "Crear objetivo"}</button>{editing && <button type="button" className="ibtn" disabled={busy} onClick={resetObjective}>Cancelar edición</button>}</div>
      </form>
    </section>

    <section className="panel organization-links">
      <div className="section-head"><div><span className="organization-kicker">CARTERA</span><h2>Proyectos y objetivos</h2></div><span className="meta">{projects.length}</span></div>
      <p className="organization-meta">Un proyecto puede contribuir a varios objetivos y tener como máximo uno principal. Los personales pueden permanecer sin objetivo.</p>
      {projects.length === 0 ? <p className="empty-mini">No hay repositorios descubiertos.</p> : projects.map((project) => <ProjectLinksEditor key={project.id} project={project} profile={profiles[project.id]} objectives={organization.objectives} links={organization.project_objectives[project.id] ?? emptyLinks} onSaved={setOrganization} />)}
    </section>
  </div>;
}
