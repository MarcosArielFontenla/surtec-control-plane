import { useCallback, useEffect, useRef, useState } from "react";
import type { OperatingRow, OperatingSection, OperatingSectionKind, OperatingView } from "../../../../lib/operating-views";
import { getOperatingObjective } from "../api";
import type { OperatingNavigationTarget } from "../views/OrganizationView";

const PAGE_SIZE = 8;
const SECTION_LABEL: Partial<Record<OperatingSectionKind, string>> = {
  objectives: "Objetivos relacionados", projects: "Proyectos vinculados", issues: "Issues del objetivo",
  executions: "Ejecuciones y evidencia", workflows: "Workflows del objetivo", commitments: "Compromisos relacionados",
  signals: "Señales del objetivo", harness: "Harness de proyectos", sessions: "Sesiones relacionadas", budgets: "Diagnóstico de presupuesto",
};
const STATUS: Record<string, string> = {
  draft: "Borrador", active: "Activo", paused: "Pausado", achieved: "Logrado", cancelled: "Cancelado", proposed: "Propuesto", authorized: "Autorizado",
  working: "En trabajo", checking: "En verificación", "needs-decision": "Necesita decisión", "ready-for-review": "Listo para revisión", done: "Aceptado", blocked: "Bloqueado",
};
const AVAILABILITY = { available: "Disponible", absent: "Sin registro opcional", unavailable: "No disponible", "not-enabled": "No habilitado" };
const FRESHNESS = { fresh: "Vigente", stale: "Desactualizada", unknown: "Frescura desconocida", "not-applicable": "Frescura no aplicable" };
const ORIGIN = { saved: "guardada", "live-local": "local", manual: "manual" };
const SOURCE_REASON: Record<OperatingSection["source"]["reason"], string> = {
  observed: "lectura observada", "coverage-incomplete": "cobertura incompleta", "optional-absent": "fuente opcional sin registro", "missing-source": "fuente no disponible",
  "read-failed": "lectura fallida", "invalid-source": "fuente inválida", "not-configured": "sin configurar", "phase-p-deferred": "Fase P diferida", "not-required": "no requerido",
};
const GAPS: Record<OperatingRow["lineage"]["gaps"][number], string> = {
  "project-unavailable": "Proyecto no disponible", "objective-unavailable": "Objetivo no disponible", "issue-unavailable": "Issue no disponible",
  "cross-project": "Referencia entre proyectos incompatible", "objective-not-linked": "Objetivo sin vínculo canónico", "objective-cycle": "Ciclo en la ancestría",
  "objective-depth": "Ancestría excede ocho niveles", "incomplete-source": "Fuente de relaciones incompleta",
};
const REASONS: Record<NonNullable<OperatingRow["decision_reason"]>, string> = {
  "scope-changed": "Cambió el alcance", "policy-changed": "Cambió la política", "conflicting-evidence": "Evidencia en conflicto", "budget-exhausted": "Presupuesto agotado",
  "correction-exhausted": "Correcciones agotadas", "required-harness": "Falta Harness requerido", "external-action": "Acción externa requiere autorización",
  "dependency-blocked": "Dependencia bloqueada", "evidence-gap": "La evidencia no clasifica el motivo",
};

function destination(row: OperatingRow): { label: string; target: OperatingNavigationTarget } | null {
  if (row.kind === "objectives") return { label: `Ver objetivo ${row.label}`, target: { kind: "objective", id: row.id } };
  if (row.kind === "projects") return { label: `Ver proyecto ${row.label}`, target: { kind: "project", id: row.id } };
  if (row.kind === "issues" && row.project_id) return { label: `Ver issues: ${row.label}`, target: { kind: "issue", id: row.id, projectId: row.project_id } };
  if (row.kind === "executions") return { label: `Ver tarea ${row.label}`, target: { kind: "task", id: row.id } };
  if (row.kind === "workflows" && row.project_id && row.issue_id) return { label: `Ver workflow ${row.label}`, target: { kind: "workflow", id: row.id, projectId: row.project_id, issueId: row.issue_id } };
  if (["signals", "harness", "sessions"].includes(row.kind) && row.project_id) return { label: `Ver proyecto ${row.label}`, target: { kind: "project", id: row.project_id } };
  return null;
}

function health(view: OperatingView, objective: OperatingRow | undefined): { label: string; reasons: string[]; next: OperatingRow | undefined } {
  const reasons: string[] = [];
  const issues = view.sections.find(section => section.kind === "issues")!;
  const projects = view.sections.find(section => section.kind === "projects")!;
  const decision = [...issues.rows, ...view.sections.filter(section => section.kind === "workflows" || section.kind === "executions").flatMap(section => section.rows)]
    .find(row => row.operating_state === "blocked" || row.operating_state === "needs-decision");
  if (!objective) reasons.push("La ficha seleccionada no está en esta página; no se usa otro objetivo en su lugar.");
  else {
    if (!objective.summary) reasons.push("Resultado deseado sin registro.");
    if (objective.criteria.length === 0) reasons.push("Faltan criterios de éxito.");
    reasons.push(...objective.lineage.gaps.map(gap => GAPS[gap]));
    if (!objective.reviewed_on) reasons.push("Fecha de revisión pendiente.");
    else if (Date.parse(view.generated_at.slice(0, 10)) - Date.parse(objective.reviewed_on) >= 30 * 86400000) reasons.push("La revisión del objetivo tiene al menos 30 días.");
    if (objective.target_date && objective.target_date < view.generated_at.slice(0, 10) && !["achieved", "cancelled"].includes(objective.state ?? "")) reasons.push("La fecha objetivo registrada ya pasó; no implica por sí sola un bloqueo ni una decisión.");
  }
  if (projects.total === 0) reasons.push("Sin proyectos vinculados en la fuente validada.");
  for (const section of view.sections.filter(section => ["objectives", "projects", "issues", "workflows", "executions", "signals"].includes(section.kind))) {
    const name = SECTION_LABEL[section.kind];
    if (section.source.availability !== "available" || section.coverage !== "complete") reasons.push(`${name}: cobertura no confirmada.`);
    if (section.source.availability === "available" && section.source.freshness !== "fresh") reasons.push(`${name}: ${FRESHNESS[section.source.freshness].toLowerCase()}.`);
    if (section.next_cursor || section.has_more === null) reasons.push(`${name}: la página no representa toda la evidencia.`);
  }
  if (decision) reasons.unshift(`Atención visible: ${decision.label} · ${decision.decision_reason ? REASONS[decision.decision_reason] : "Motivo no clasificado"}.`);
  return { label: decision ? "Atención en evidencia visible" : reasons.length ? "Evaluación incompleta / requiere revisión" : "Sin brechas observadas en esta lectura", reasons,
    next: decision ?? projects.rows[0] };
}

function SourceMetadata({ section }: { section: OperatingSection }) {
  const source = section.source;
  return <>
    <p className="operating-source">{AVAILABILITY[source.availability]} · {SOURCE_REASON[source.reason]} · {FRESHNESS[source.freshness]} · Cobertura {section.coverage === "complete" ? "completa" : section.coverage === "partial" ? "parcial" : "no disponible"}</p>
    <p className="organization-meta">Fuente {source.origin ? ORIGIN[source.origin] : "sin procedencia disponible"} · Observada: {source.observed_at ? <time dateTime={source.observed_at}>{source.observed_at}</time> : "fecha desconocida"}{source.fresh_until && <> · Vigente hasta: <time dateTime={source.fresh_until}>{source.fresh_until}</time></>}</p>
  </>;
}

export function ObjectiveDetailPanel({ objectiveId, onNavigate, onClose, refreshKey = 0 }: {
  objectiveId: string; onNavigate?: (target: OperatingNavigationTarget) => void; onClose?: () => void; refreshKey?: number;
}) {
  const [snapshot, setSnapshot] = useState<{ id: string; view: OperatingView } | null>(null);
  const [loading, setLoading] = useState(true), [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const mounted = useRef(false), sequence = useRef(0), busy = useRef(false);
  const cursors = useRef<Partial<Record<OperatingSectionKind, string>>>({});
  const panel = useRef<HTMLElement>(null);
  const view = snapshot?.id === objectiveId ? snapshot.view : null;
  const error = failure?.id === objectiveId ? failure.message : null;
  const read = useCallback(async (section?: OperatingSectionKind, cursor?: string) => {
    if (!mounted.current || busy.current) return;
    busy.current = true;
    const generation = ++sequence.current;
    const next = section ? { ...cursors.current } : {};
    if (section) { if (cursor) next[section] = cursor; else delete next[section]; }
    setLoading(true); setFailure(null);
    try {
      const result = await getOperatingObjective(objectiveId, { page_size: PAGE_SIZE, ...(Object.keys(next).length ? { cursors: next } : {}) });
      if (!mounted.current || generation !== sequence.current) return;
      cursors.current = next; setSnapshot({ id: objectiveId, view: result });
    } catch {
      if (mounted.current && generation === sequence.current) setFailure({ id: objectiveId, message: "No se pudo leer el objetivo solicitado. Puede no existir o su fuente no estar disponible; no se selecciona otro objetivo." });
    } finally { if (mounted.current && generation === sequence.current) { busy.current = false; setLoading(false); } }
  }, [objectiveId]);
  useEffect(() => {
    mounted.current = true; busy.current = false; cursors.current = {}; setSnapshot(null); setFailure(null);
    void read();
    return () => { mounted.current = false; busy.current = false; sequence.current++; };
  }, [read, refreshKey]);
  useEffect(() => { panel.current?.scrollIntoView?.({ block: "nearest" }); panel.current?.focus({ preventScroll: true }); }, [objectiveId]);

  const objectives = view?.sections.find(section => section.kind === "objectives");
  const objective = objectives?.rows.find(row => row.id === objectiveId);
  const explanation = view ? health(view, objective) : null;
  const next = explanation?.next ? destination(explanation.next) : null;

  return <section className="panel operating-overview" aria-label="Detalle de objetivo" aria-busy={loading} tabIndex={-1} ref={panel}>
    <div className="section-head"><div><span className="organization-kicker">OBJETIVO · EVIDENCIA CONECTADA</span><h2>{objective?.label ?? "Detalle de objetivo"}</h2></div><div className="organization-form-actions"><button type="button" className="ibtn" disabled={loading} onClick={() => void read()}>Actualizar objetivo</button>{onClose && <button type="button" className="ibtn" onClick={onClose}>Cerrar detalle de objetivo</button>}</div></div>
    <p className="organization-meta">Objetivo seleccionado: {objectiveId}. Solo lectura: navegar no autoriza trabajo ni publica resultados.</p>
    {loading && <p role="status">Leyendo detalle de objetivo…</p>}
    {error && <p className="organization-error" role="alert">{error}{view && " Se conserva la última lectura de este objetivo, no confirmada por el intento actual."}</p>}
    {view && <>
      <p className="organization-meta">Proyección generada: <time dateTime={view.generated_at}>{view.generated_at}</time>. No es la fecha de observación de las fuentes.</p>
      {view.focus_status !== "available" && <p role="alert">{view.focus_status === "not-found" ? "El objetivo no está en la fuente validada." : "No se pudo confirmar el objetivo con la fuente disponible."} No se elige otro registro.</p>}
      <div className="operating-grid">
        <section className="operating-section" aria-label="Resultado y criterios"><h3>Resultado y criterios</h3>
          {objective ? <><p>Estado registrado: {STATUS[objective.state ?? ""] ?? objective.state ?? "desconocido"}</p><p>{objective.summary ?? "Resultado deseado sin registro."}</p>{objective.criteria.length ? <ul>{objective.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul> : <p className="organization-gap">Faltan criterios de éxito.</p>}
            <p>Fecha objetivo: {objective.target_date ?? "sin fecha"} · Revisado: {objective.reviewed_on ?? "pendiente"}</p><p className="organization-meta">La revisión es una fecha guardada; no confirma la frescura ni la aceptación del trabajo.</p></>
            : <p className="organization-gap">La ficha seleccionada no está en esta página. Revisá la disponibilidad y las páginas de Objetivos relacionados; no se usa otro objetivo en su lugar.</p>}
          {objectives && <SourceMetadata section={objectives} />}
        </section>
        <section className="operating-section" aria-label="Ancestría canónica"><h3>Ancestría canónica</h3>
          <p className="organization-meta">Ruta observada hacia el objetivo · hasta ocho niveles. Las brechas pueden impedir confirmar una raíz; no se completan relaciones desde inventarios globales.</p>
          {objective ? <><p>Objetivo superior registrado: {objective.parent_objective_id ?? "sin superior"}</p><ol>{objective.lineage.objective_ids.map(id => <li key={id}>{objectives?.rows.find(row => row.id === id)?.label ?? id} · {id}{!objectives?.rows.some(row => row.id === id) && " · ficha fuera de esta página"}{id !== objectiveId && onNavigate && <button className="ibtn" type="button" onClick={() => onNavigate({ kind: "objective", id })}>Ver objetivo {id}</button>}</li>)}</ol>{objective.lineage.gaps.map(gap => <p className="organization-gap" key={gap}>{GAPS[gap]}</p>)}</> : <p>Relación no confirmada para la ficha seleccionada.</p>}
        </section>
        <section className="operating-section" aria-label="Salud explicada"><h3>Salud explicada</h3><p>{explanation?.label}</p>
          <ul>{explanation?.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul><p className="organization-meta">Evaluación de la evidencia visible, no un porcentaje de avance ni permiso de ejecución. Ausencia de alertas en una página no prueba salud global.</p>
        </section>
        <section className="operating-section" aria-label="Siguiente paso seguro"><h3>Siguiente paso seguro</h3>
          <p>{explanation?.next?.decision_reason ? `Inspeccionar evidencia: ${REASONS[explanation.next.decision_reason]}.` : "Revisar criterios, relaciones y fechas; luego inspeccionar la evidencia disponible."}</p>
          {next && onNavigate && <button type="button" className="ibtn" onClick={() => onNavigate(next.target)}>{next.label}</button>}
          <p className="organization-meta">Toda autorización, preview, corrección y aceptación conserva sus gates existentes. Presupuestos P no habilitados; continuidad diferida.</p>
        </section>
        {view.sections.filter(section => section.kind !== "company").map(section => {
          const title = SECTION_LABEL[section.kind]!;
          const open = section.kind === "issues" ? section.rows.filter(row => !["done", "cancelled"].includes(row.state ?? "")).length : null;
          return <section className="operating-section" aria-label={title} key={section.kind}>
            <div className="operating-section-head"><h3>{title}</h3><span>{section.total === null ? "Total desconocido" : `${section.total} en total (todos los estados)`}</span></div>
            <SourceMetadata section={section} />
            {section.kind === "objectives" && <p className="organization-meta">Ancestros, foco y descendientes observados. La ficha seleccionada puede estar en otra página.</p>}
            {section.kind === "projects" && <p className="organization-meta">Vínculos canónicos al objetivo o sus descendientes; cada proyecto aparece una vez. Sus issues no heredan objetivos secundarios.</p>}
            {section.kind === "issues" && <p className="organization-meta">Página visible: {open} abiertas (incluye propuestas/autorizadas), {section.rows.filter(row => row.operating_state === "blocked").length} bloqueadas. No son totales globales de actividad.</p>}
            {section.kind === "executions" && <p className="organization-meta">Ejecuciones relacionadas, ordenadas por ID, no por recencia: no hay fecha individual en esta proyección. Una tarea finalizada no implica issue aceptado.</p>}
            {section.kind === "commitments" && <><p className="organization-meta">Solo relaciones canónicas observadas; el adaptador actual usa el objetivo principal del proyecto, no todos sus objetivos secundarios. Completado no implica entrega o respuesta del cliente.</p>{onNavigate && <button type="button" className="ibtn" onClick={() => onNavigate({ kind: "section", section: "commitments" })}>Ver compromisos</button>}</>}
            {section.kind === "budgets" && <p className="organization-gap">No habilitado · solo diagnóstico, saldo desconocido. No activa admisión ni efectos de Fase P.</p>}
            {section.rows.length === 0 && <p className="empty-mini">{section.total === 0 ? "Sin registros en la fuente validada para este objetivo." : "Sin filas en esta página; no prueba ausencia de registros."}</p>}
            <ul className="operating-rows">{section.rows.map(row => {
              const navigation = destination(row);
              return <li key={row.id}>
                <div className="operating-row-head"><b>{row.label}</b><span>{STATUS[row.operating_state ?? row.state ?? ""] ?? row.state ?? "Sin estado registrado"}</span></div>
                <small>{row.id}{row.project_id && ` · Proyecto ${row.project_id}`}</small>
                {row.secondary_state && <p>Estado de origen: {row.secondary_state}</p>}{row.summary && <p>{row.summary}</p>}
                {row.decision_reason && <p className="organization-gap">Motivo: {REASONS[row.decision_reason]}</p>}
                {row.target_date && <p>Fecha objetivo: {row.target_date}</p>}{row.reviewed_on && <p>Revisado: {row.reviewed_on}</p>}
                {row.kind === "executions" && <p>Resultado registrado: {row.result_status ?? "desconocido"}</p>}
                {(row.kind === "issues" || row.kind === "executions") && <><p>Candidato: {row.candidate_validity === "current" ? "actual según evidencia registrada" : row.candidate_validity === "stale" ? "desactualizado" : "validez desconocida"} · Referencias de evidencia: {row.evidence_ids.length ? row.evidence_ids.join(", ") : "sin referencias en esta proyección"}</p><p className="organization-meta">Referencias acotadas, no prueba de aceptación. Abrí el issue o la tarea para inspeccionar la evidencia completa.</p></>}
                {row.kind === "harness" && <p>Validación registrada: {row.validation_status === "passed" ? "pasó" : row.validation_status === "failed" ? "falló" : "desconocida"}. Presencia no implica validación ni permisos.</p>}
                {row.lineage.gaps.map(gap => <p className="organization-gap" key={gap}>{GAPS[gap]}</p>)}
                {navigation && onNavigate && !(row.kind === "objectives" && row.id === objectiveId) && <button type="button" className="ibtn" onClick={() => onNavigate(navigation.target)}>{navigation.label}</button>}
              </li>;
            })}</ul>
            <div className="operating-pagination"><span className="organization-meta">{section.rows.length} filas visibles{section.has_more === null ? " · Continuación desconocida" : section.has_more ? " · Hay más registros" : " · Fin de esta lectura"}</span>{section.next_cursor && <button type="button" className="ibtn" disabled={loading} onClick={() => void read(section.kind, section.next_cursor!)}>Siguiente página de {title}</button>}<button type="button" className="ghost-btn" disabled={loading} onClick={() => void read(section.kind)}>Primera página de {title}</button></div>
          </section>;
        })}
      </div>
    </>}
  </section>;
}
