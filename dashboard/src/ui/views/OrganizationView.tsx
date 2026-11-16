import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanyProfile, Objective, ObjectiveHorizon, ObjectiveStatus, OrganizationSnapshot, ProjectObjectiveLinks } from "../../../../lib/organization";
import type { ProjectView } from "../../../../lib/state/types";
import type { ProjectProfile } from "../../../../lib/portfolio-profile";
import type { OperatingRow, OperatingSection, OperatingSectionKind, OperatingView } from "../../../../lib/operating-views";
import { createObjective, getOperatingOverview, getOrganization, saveCompanyProfile, saveObjective, saveProjectObjectiveLinks } from "../api";
import { ObjectiveDetailPanel } from "../components/ObjectiveDetailPanel";

export type OperatingNavigationTarget =
  | { kind: "objective" | "project" | "task"; id: string }
  | { kind: "issue"; id: string; projectId: string }
  | { kind: "workflow"; id: string; issueId: string; projectId: string }
  | { kind: "section"; section: "commitments" | "sessions" };

const SECTION_LABEL: Record<OperatingSectionKind, string> = {
  company: "Empresa", objectives: "Objetivos activos y estrategia", projects: "Proyectos", issues: "Issues y decisiones",
  executions: "Ejecuciones", workflows: "Workflows", signals: "Señales", commitments: "Compromisos",
  harness: "Harness", sessions: "Sesiones de trabajo", budgets: "Presupuestos",
};
const AVAILABILITY = { available: "Disponible", absent: "Sin registro opcional", unavailable: "No disponible", "not-enabled": "No habilitado" };
const FRESHNESS = { fresh: "Vigente", stale: "Desactualizada", unknown: "Frescura desconocida", "not-applicable": "Frescura no aplicable" };
const ORIGIN = { saved: "guardada", "live-local": "local", manual: "manual" };
const SOURCE_REASON: Record<OperatingSection["source"]["reason"], string> = {
  observed: "lectura observada", "coverage-incomplete": "cobertura incompleta", "optional-absent": "fuente opcional sin registro",
  "missing-source": "fuente no disponible", "read-failed": "lectura fallida", "invalid-source": "fuente inválida",
  "not-configured": "sin configurar", "phase-p-deferred": "Fase P diferida", "not-required": "no requerido",
};
const OPERATING_STATE = { working: "En trabajo", checking: "En verificación", "needs-decision": "Necesita decisión", "ready-for-review": "Lista para revisión", done: "Aceptada", blocked: "Bloqueada" };
const DECISION_REASON: Record<NonNullable<OperatingRow["decision_reason"]>, string> = {
  "scope-changed": "Cambió el alcance", "policy-changed": "Cambió la política", "conflicting-evidence": "Evidencia en conflicto",
  "budget-exhausted": "Presupuesto agotado", "correction-exhausted": "Correcciones agotadas", "required-harness": "Falta Harness requerido",
  "external-action": "Acción externa requiere autorización", "dependency-blocked": "Dependencia bloqueada", "evidence-gap": "La evidencia no clasifica el motivo",
};

function rowNavigation(row: OperatingRow): { label: string; target: OperatingNavigationTarget } | null {
  switch (row.kind) {
    case "objectives": return { label: `Ver objetivo ${row.label}`, target: { kind: "objective", id: row.id } };
    case "projects": return { label: `Ver proyecto ${row.label}`, target: { kind: "project", id: row.id } };
    case "executions": return { label: `Ver tarea ${row.label}`, target: { kind: "task", id: row.id } };
    case "issues": return row.project_id ? { label: `Ver issues: ${row.label}`, target: { kind: "issue", id: row.id, projectId: row.project_id } } : null;
    case "workflows": return row.project_id && row.issue_id ? { label: `Ver workflow ${row.label}`, target: { kind: "workflow", id: row.id, issueId: row.issue_id, projectId: row.project_id } } : null;
    case "harness": case "signals": return row.project_id ? { label: `Ver proyecto ${row.label}`, target: { kind: "project", id: row.project_id } } : null;
    case "commitments": return null;
    case "sessions": return row.project_id ? { label: `Ver proyecto ${row.label}`, target: { kind: "project", id: row.project_id } } : { label: "Ver sesiones", target: { kind: "section", section: "sessions" } };
    default: return null;
  }
}

function OperatingOverview({ view, loading, error, onRead, onNavigate }: {
  view: OperatingView | null; loading: boolean; error: string | null;
  onRead: (section?: OperatingSectionKind, cursor?: string) => void;
  onNavigate?: (target: OperatingNavigationTarget) => void;
}) {
  return <section className="panel operating-overview" aria-label="Overview operativo SURTEC" aria-busy={loading}>
    <div className="section-head"><div><span className="organization-kicker">SURTEC · LECTURA OPERATIVA</span><h2>De la estrategia a la evidencia</h2></div><button type="button" className="ibtn" disabled={loading} onClick={() => onRead()}>Actualizar lectura</button></div>
    <p className="organization-meta">Solo lectura · navegar no autoriza ni ejecuta trabajo. Presupuestos: no habilitados / solo diagnóstico. Continuidad: Fase P diferida.</p>
    {loading && <p role="status">Leyendo estado operativo…</p>}
    {error && <p role="alert" className="organization-error">{error}{view ? " Se conserva la última lectura, no confirmada por este intento." : ""}</p>}
    {view && <>
      <p className="organization-meta">Proyección generada: <time dateTime={view.generated_at}>{view.generated_at}</time>. No reemplaza la fecha de observación de cada fuente.</p>
      <div className="operating-grid">{view.sections.map((section) => {
        const source = section.source, title = SECTION_LABEL[section.kind];
        const distribution = section.kind === "projects" ? [...new Set(section.rows.map((row) => `${row.project_kind ?? "tipo desconocido"} · ${row.state ?? "estado desconocido"}`))].map((key) => `${key}: ${section.rows.filter((row) => `${row.project_kind ?? "tipo desconocido"} · ${row.state ?? "estado desconocido"}` === key).length}`).join("; ") : null;
        return <section key={section.kind} className="operating-section" aria-label={title}>
          <div className="operating-section-head"><h3>{title}</h3><span>{section.total === null ? "Total desconocido" : `${section.total} en total`}</span></div>
          <p className="operating-source">{AVAILABILITY[source.availability]} · {SOURCE_REASON[source.reason]} · {FRESHNESS[source.freshness]} · Cobertura {section.coverage === "complete" ? "completa" : section.coverage === "partial" ? "parcial" : "no disponible"}</p>
          <p className="organization-meta">Fuente {source.origin ? ORIGIN[source.origin] : "sin procedencia disponible"} · Observada: {source.observed_at ? <time dateTime={source.observed_at}>{source.observed_at}</time> : "fecha desconocida"}{source.fresh_until && <> · Vigente hasta: <time dateTime={source.fresh_until}>{source.fresh_until}</time></>}</p>
          {distribution && <p className="organization-meta">Distribución de la página visible ({section.rows.length}): {distribution}. No representa toda la cartera.</p>}
          {section.kind === "signals" && <p className="organization-meta">Criticidad no clasificada por esta proyección; ausencia de datos no significa ausencia de alertas.</p>}
          {section.kind === "commitments" && <p className="organization-meta">Fechas y estados registrados; riesgo no clasificado. Completado no implica entrega ni respuesta del cliente.</p>}
          {section.kind === "sessions" && <p className="organization-meta">Estado guardado; una sesión activa no prueba actividad en tiempo real.</p>}
          {onNavigate && (section.kind === "sessions" || section.kind === "commitments") && <button type="button" className="ibtn" onClick={() => onNavigate({ kind: "section", section: section.kind === "sessions" ? "sessions" : "commitments" })}>{section.kind === "sessions" ? "Ver sesiones" : "Ver compromisos"}</button>}
          {section.kind === "budgets" && <p className="organization-gap">No habilitado · solo diagnóstico. Saldo desconocido; no activa admisión ni efectos de Fase P.</p>}
          {section.rows.length === 0 && <p className="empty-mini">{source.availability === "available" && section.total === 0 ? "Sin registros en la fuente validada." : "Sin filas en esta página; no prueba un inventario vacío."}</p>}
          <ul className="operating-rows">{section.rows.map((row) => {
            const navigation = rowNavigation(row);
            return <li key={row.id}>
              <div className="operating-row-head"><b>{row.label}</b><span>{row.operating_state ? OPERATING_STATE[row.operating_state] : row.state ?? "Sin estado registrado"}</span></div>
              <small>{row.id}{row.project_id && <> · Proyecto {row.project_id}</>}</small>
              {row.secondary_state && <p>Estado de origen: {row.secondary_state}</p>}
              {row.summary && <p>{row.summary}</p>}
              {row.principles.length > 0 && <ul>{row.principles.map((principle, index) => <li key={index}>{principle}</li>)}</ul>}
              {row.decision_reason && <p className="organization-gap">Motivo: {DECISION_REASON[row.decision_reason]}. Próximo paso: inspeccionar evidencia; toda decisión conserva sus gates.</p>}
              {row.target_date && <p>Fecha objetivo: {row.target_date}</p>}{row.reviewed_on && <p>Revisado: {row.reviewed_on}</p>}
              {row.kind === "executions" && <p>Resultado: {row.result_status ?? "desconocido"}. Tarea finalizada no equivale a issue aceptado.</p>}
              {row.kind === "harness" && <p>Validación registrada: {row.validation_status === "passed" ? "pasó" : row.validation_status === "failed" ? "falló" : "desconocida"}. Presencia no implica validación ni permisos.</p>}
              {row.kind !== "company" && <p className="organization-meta">{row.lineage.alignment === "intentionally-unaligned" ? "Sin objetivo por elección personal/experimental" : row.lineage.alignment === "aligned" ? `Objetivos: ${row.lineage.objective_ids.join(", ")}` : "Alineación no confirmada"} · Rol: {row.role_id ?? "sin asignación registrada"}{row.lineage.gaps.length > 0 && " · Relaciones incompletas"}</p>}
              {navigation && onNavigate && <button type="button" className="ibtn" onClick={() => onNavigate(navigation.target)}>{navigation.label}</button>}
            </li>;
          })}</ul>
          <div className="operating-pagination"><span className="organization-meta">{section.rows.length} filas visibles{section.has_more === null ? " · Continuación desconocida" : section.has_more ? " · Hay más registros" : " · Fin de esta lectura"}</span>{section.next_cursor && <button type="button" className="ibtn" disabled={loading} onClick={() => onRead(section.kind, section.next_cursor!)}>Siguiente página de {title}</button>}<button type="button" className="ghost-btn" disabled={loading} onClick={() => onRead(section.kind)}>Primera página de {title}</button></div>
        </section>;
      })}</div>
    </>}
  </section>;
}

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
  const linksKey = links.objective_ids.join("\0");
  useEffect(() => { setSelected(links.objective_ids); setPrimary(links.primary_objective_id ?? ""); }, [linksKey, links.primary_objective_id]);
  const toggle = (id: string, checked: boolean) => {
    const next = checked ? [...selected, id] : selected.filter((item) => item !== id);
    setSelected(next);
    if (!next.includes(primary)) setPrimary("");
  };
  const save = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await saveProjectObjectiveLinks(project.id, { objective_ids: selected, primary_objective_id: primary || null });
      onSaved(result.organization);
    } catch { setError("No se pudieron guardar los vínculos. Revisá el estado local antes de reintentar."); }
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

export function OrganizationView({ projects, profiles, onNavigate, focusedObjectiveId, onCloseObjective }: {
  projects: ProjectView[]; profiles: Record<string, ProjectProfile>;
  onNavigate?: (target: OperatingNavigationTarget) => void; focusedObjectiveId?: string | null; onCloseObjective?: () => void;
}) {
  const [localObjectiveId, setLocalObjectiveId] = useState<string | null>(null);
  const selectedObjectiveId = focusedObjectiveId === undefined ? localObjectiveId : focusedObjectiveId;
  const [objectiveRefreshKey, setObjectiveRefreshKey] = useState(0);
  const navigate = (target: OperatingNavigationTarget) => {
    if (target.kind === "objective") setLocalObjectiveId(target.id);
    onNavigate?.(target);
  };
  const [organization, setOrganization] = useState<OrganizationSnapshot | null>(null);
  const [operating, setOperating] = useState<OperatingView | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const readGeneration = useRef(0), readBusy = useRef(false), mounted = useRef(false);
  const editorGeneration = useRef(0);
  const pendingRefresh = useRef(false);
  const cursors = useRef<Partial<Record<OperatingSectionKind, string>>>({});
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
    const generation = ++editorGeneration.current;
    try {
      const result = await getOrganization();
      if (mounted.current && generation === editorGeneration.current) setOrganization(result);
    } catch (reason) { if (mounted.current && generation === editorGeneration.current) throw reason; }
  };
  const readOperating = useCallback(async (section?: OperatingSectionKind, cursor?: string) => {
    if (!mounted.current) return;
    if (readBusy.current) { if (!section) pendingRefresh.current = true; return; }
    readBusy.current = true;
    const generation = ++readGeneration.current;
    const next = section ? { ...cursors.current } : {};
    if (section) { if (cursor) next[section] = cursor; else delete next[section]; }
    setReading(true); setReadError(null);
    try {
      const result = await getOperatingOverview({ page_size: 6, ...(Object.keys(next).length ? { cursors: next } : {}) });
      if (!mounted.current || generation !== readGeneration.current) return;
      cursors.current = next; setOperating(result);
    } catch {
      if (mounted.current && generation === readGeneration.current) setReadError("No se pudo actualizar la lectura operativa. Podés volver a la primera página o reintentar.");
    } finally {
      if (generation === readGeneration.current) {
        readBusy.current = false;
        if (mounted.current) {
          setReading(false);
          if (pendingRefresh.current) { pendingRefresh.current = false; void readOperating(); }
        }
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const generation = ++editorGeneration.current;
    void getOrganization().then((result) => {
      if (!active || generation !== editorGeneration.current) return;
      setOrganization(result); setCompanyDraft(result.company); setMission(result.company.mission ?? "");
      setDisplayName(result.company.display_name); setPrinciplesText(result.company.operating_principles.join("\n"));
    }).catch(() => { if (active && generation === editorGeneration.current) setError("No se pudieron cargar los editores de SURTEC. La lectura operativa es independiente."); });
    void readOperating();
    return () => { active = false; mounted.current = false; readGeneration.current++; editorGeneration.current++; readBusy.current = false; pendingRefresh.current = false; };
  }, [readOperating]);

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
    editorGeneration.current++;
    setBusy(true); setError(null); setNotice(null);
    try {
      if (editing) {
        await saveObjective({ ...editing, title: title.trim(), desired_outcome: outcome.trim(), success_criteria: criteria(), status, horizon, priority, target_date: targetDate || null, parent_objective_id: parentId || null });
      } else {
        await createObjective({ title: title.trim(), desired_outcome: outcome.trim(), success_criteria: criteria(), status, horizon, priority, target_date: targetDate || null, parent_objective_id: parentId || null });
      }
      setNotice("Objetivo guardado en el estado local."); resetObjective();
      setObjectiveRefreshKey(value => value + 1);
      void refresh().catch(() => { if (mounted.current) setError("El objetivo se guardó, pero no se pudo releer el editor. No repitas el guardado para refrescarlo."); });
      void readOperating();
    } catch { setError("No se pudo guardar el objetivo. Revisá el estado local antes de reintentar."); }
    finally { setBusy(false); }
  };
  const submitCompany = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!companyDraft || busy) return;
    editorGeneration.current++;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await saveCompanyProfile({ ...companyDraft, display_name: displayName.trim(), mission: mission.trim() || null, operating_principles: [...new Set(principlesText.split("\n").map((item) => item.trim()).filter(Boolean))] });
      setCompanyDraft({ ...companyDraft, ...result.company });
      setOrganization((current) => current ? { ...current, company: { ...current.company, ...result.company } } : current);
      setNotice("Perfil SURTEC guardado localmente."); setObjectiveRefreshKey(value => value + 1); void readOperating();
    } catch { setError("No se pudo guardar el perfil. Revisá el estado local antes de reintentar."); }
    finally { setBusy(false); }
  };

  return <div className="organization-view">
    {selectedObjectiveId && <ObjectiveDetailPanel key={selectedObjectiveId} objectiveId={selectedObjectiveId} onNavigate={onNavigate ? navigate : undefined} refreshKey={objectiveRefreshKey} onClose={() => { const card = document.getElementById(`organization-objective-${selectedObjectiveId}`); setLocalObjectiveId(null); onCloseObjective?.(); card?.focus({ preventScroll: true }); }} />}
    <OperatingOverview view={operating} loading={reading} error={readError} onRead={(section, cursor) => void readOperating(section, cursor)} onNavigate={onNavigate ? navigate : undefined} />
    {!organization ? <section className="panel organization-company">{error ? <p role="alert">{error}</p> : <p role="status">Cargando editores SURTEC…</p>}</section> : <>
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
          const structuralGap = objective.project_ids.length === 0 || objective.success_criteria.length === 0;
          const stale = isStale(objective.last_reviewed_at);
          const health = objective.status === "paused" ? "Pausada" : objective.status === "achieved" ? "Lograda" : objective.status === "cancelled" ? "Cancelada" : structuralGap || stale ? "Requiere revisión" : "Salud no confirmada";
          return <article key={objective.id} id={`organization-objective-${objective.id}`} tabIndex={-1} className={`organization-objective-card${selectedObjectiveId === objective.id ? " organization-objective-card--selected" : ""}`}>
            <div className="organization-objective-top"><span className={`organization-status organization-status--${objective.status}`}>{STATUS_LABEL[objective.status]}</span><span className="organization-health">{health}</span></div>
            <h3>{objective.title}</h3><p>{objective.desired_outcome}</p>
            <div className="organization-objective-facts"><span>{HORIZON_LABEL[objective.horizon]}</span><span>Prioridad {objective.priority}</span><span>Objetivo: {objective.target_date ?? "sin fecha"}</span></div>
            {objective.success_criteria.length === 0 ? <p className="organization-gap">Faltan criterios de éxito.</p> : <ul>{objective.success_criteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>}
            {objective.project_ids.length === 0 ? <p className="organization-gap">Sin proyectos vinculados.</p> : <p className="organization-linked">Proyectos: {objective.project_ids.map((id) => projects.find((project) => project.id === id)?.id ?? id).join(", ")}</p>}
            <p className="organization-meta">Revisado: {objective.last_reviewed_at ?? "nunca"} · El editor no calcula salud; consultá la cobertura y observación de la lectura operativa.</p>
            <button type="button" className="ibtn" onClick={() => editObjective(objective)}>Editar objetivo</button>
            <button type="button" className="ibtn" style={{ maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere", textAlign: "left" }} onClick={() => navigate({ kind: "objective", id: objective.id })}>Ver detalle de objetivo {objective.title}</button>
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
      {projects.length === 0 ? <p className="empty-mini">No hay repositorios descubiertos.</p> : projects.map((project) => <ProjectLinksEditor key={project.id} project={project} profile={profiles[project.id]} objectives={organization.objectives} links={organization.project_objectives[project.id] ?? emptyLinks} onSaved={(snapshot) => { editorGeneration.current++; setOrganization(snapshot); setObjectiveRefreshKey(value => value + 1); void readOperating(); }} />)}
    </section>
    </>}
  </div>;
}
