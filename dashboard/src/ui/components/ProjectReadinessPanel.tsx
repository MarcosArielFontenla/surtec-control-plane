import { useEffect, useRef, useState } from "react";
import type { ProjectView } from "../../../../lib/state/types";
import type { OperatingRow, OperatingView } from "../../../../lib/operating-views";
import type { ProjectIntegrationsSnapshot } from "../../../../lib/integrations/types";
import { isSafeIdentifier } from "../../../../lib/security/identifiers";
import { fetchDispatchOptions, getOperatingProject, type DispatchProjectCapability } from "../api";

export type ProjectReadinessNavigationTarget =
  | { kind: "issues"; projectId: string }
  | { kind: "issue"; id: string; projectId: string }
  | { kind: "workflow"; id: string; issueId: string; projectId: string };

const decisions: Record<string, string> = {
  "scope-changed": "Cambio de scope", "policy-changed": "Cambio de política", "conflicting-evidence": "Evidencia en conflicto",
  "budget-exhausted": "Límite registrado agotado", "correction-exhausted": "Corrección acotada agotada", "required-harness": "Requisito Harness pendiente",
  "external-action": "Acción externa requiere decisión", "dependency-blocked": "Dependencia bloqueante", "evidence-gap": "Motivo no clasificado por la fuente",
};

function confirmedCapability(value: DispatchProjectCapability): boolean {
  return !!value && isSafeIdentifier(value.project) && typeof value.has_local_checkout === "boolean"
    && typeof value.has_verification_commands === "boolean" && Array.isArray(value.allowed_agents) && value.allowed_agents.every(isSafeIdentifier)
    && ["read-only", "workspace-write"].includes(value.project_sandbox_ceiling) && Array.isArray(value.agents)
    && value.agents.every(agent => agent && isSafeIdentifier(agent.agent) && value.allowed_agents.includes(agent.agent)
      && Array.isArray(agent.modes) && agent.modes.every(mode => mode && ["read-only", "workspace-write", "workspace-write-verify"].includes(mode.mode)
        && typeof mode.allowed === "boolean" && (mode.reason === null || typeof mode.reason === "string")));
}

export function ProjectReadinessPanel({ project, integrations, integrationsLoading, integrationsUnavailable, onNavigate, onOpenTask }: {
  project: ProjectView;
  integrations: ProjectIntegrationsSnapshot | null;
  integrationsLoading: boolean;
  integrationsUnavailable: boolean;
  onNavigate?: (target: ProjectReadinessNavigationTarget) => void;
  onOpenTask: (id: string) => void;
}) {
  const sequence = useRef(0);
  const [read, setRead] = useState<{ projectId: string; pending?: boolean; view?: OperatingView; capability?: DispatchProjectCapability; optionsConfirmed?: boolean; warning?: string } | null>(null);
  const id = project.id, current = read?.projectId === id ? read : null;
  useEffect(() => { sequence.current++; setRead(null); return () => { sequence.current++; }; }, [id]);
  async function consult() {
    const request = ++sequence.current;
    setRead({ projectId: id, pending: true });
    const [operating, options] = await Promise.allSettled([getOperatingProject(id, { page_size: 6 }), fetchDispatchOptions()]);
    if (request !== sequence.current) return;
    const view = operating.status === "fulfilled" && operating.value?.schema_version === 1 && operating.value.view === "project"
      && operating.value.focus_id === id && operating.value.focus_status === "available" && operating.value.execution_authority === "none" ? operating.value : undefined;
    const matches = options.status === "fulfilled" && Array.isArray(options.value?.projects) && options.value.projects.every(value => value && isSafeIdentifier(value.project))
      ? options.value.projects.filter(value => value.project === id) : null;
    const optionsConfirmed = !!matches && (matches.length === 0 || matches.length === 1 && confirmedCapability(matches[0]!));
    setRead({ projectId: id, view, capability: optionsConfirmed ? matches?.[0] : undefined, optionsConfirmed,
      warning: !view || !optionsConfirmed ? "Una fuente de preparación no pudo confirmarse. Las demás referencias siguen disponibles; no se ejecutó ninguna acción." : undefined });
  }
  const section = (kind: "projects" | "issues" | "executions" | "workflows" | "harness" | "sessions") => current?.view?.sections.find(source => source.kind === kind);
  const exact = (row: OperatingRow) => row.project_id === id && row.lineage.project_id === id && !row.lineage.gaps.some(gap => gap === "cross-project" || gap === "project-unavailable");
  const rows = (kind: "issues" | "executions" | "workflows" | "harness") => {
    const source = section(kind); return source?.source.availability === "available" ? source.rows.filter(exact).slice(0, 6) : [];
  };
  const issues = rows("issues").filter(row => row.lineage.issue_id === row.id && !row.lineage.gaps.includes("issue-unavailable"));
  const executions = rows("executions"), workflows = rows("workflows"), harness = rows("harness").find(row => row.id === id);
  const snapshot = integrations?.schema_version === 2 && integrations.project_id === id ? integrations : null;
  return <section className="project-detail-section panel" aria-label="Preparación del proyecto" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
    <div className="section-head" style={{ flexWrap: "wrap", gap: 12 }}><div><h2>Preparación del proyecto</h2><p>Preparado para inspeccionar no significa autorizado para ejecutar.</p></div>
      <button type="button" className="ibtn" style={{ maxWidth: "100%", whiteSpace: "normal" }} disabled={current?.pending} onClick={() => void consult()}>{current?.pending ? "Consultando preparación…" : "Consultar preparación"}</button></div>
    <dl className="detail-dl">
      <dt>Repositorio / registro</dt><dd>{project.path ? "Checkout descubierto" : "Sin checkout descubierto"} · {project.configured ? "agentes configurados" : "sin agentes configurados"}. No acredita admisión.</dd>
      <dt>Integraciones observadas</dt><dd>{snapshot ? <>Git {snapshot.source_control.health} · CI {snapshot.ci.health} / {snapshot.ci.status ?? "sin estado"} · observado <time dateTime={snapshot.observed_at}>{snapshot.observed_at}</time>{integrationsUnavailable && " · falló la lectura posterior; snapshot anterior"}.</> : integrationsLoading ? "Lectura existente pendiente" : "Snapshot del proyecto no confirmado"}. Se reutiliza la lectura del detalle; no se refrescan proveedores desde este panel.</dd>
      <dt>Verificación configurada</dt><dd>{current?.capability ? current.capability.has_verification_commands ? "Hay comandos registrados; no ejecutados aquí." : "Sin comandos registrados; esto no impide por sí solo el análisis read-only." : "No confirmada; consultá las opciones actuales."} Requisitos efectivos de testing y review: revisar preview/admisión del issue o workflow exacto.</dd>
      <dt>Harness guardado</dt><dd>{harness ? <>Estado {harness.state} · validación registrada {harness.validation_status}. No acredita receipt, ownership ni vigencia.</> : current?.view ? "Sin observación exacta disponible en esta página; no equivale a instalación fallida." : "No consultado"} Este resumen usa estado guardado, no vuelve a inspeccionar el checkout.</dd>
    </dl>
    <p className="work-issue-note">Objetivo, cliente y Harness son opcionales para trabajo personal/experimental. Su ausencia no bloquea por sí sola; una política aplicable sí puede denegar. Esta vista no evalúa ni sustituye esa política.</p>
    {current?.warning && <p role="status">{current.warning}</p>}
    {current?.optionsConfirmed && <section aria-label="Opciones registradas del proyecto">
      {!current.capability ? <p>Proyecto no registrado en opciones de despacho; revisá su configuración sin elegir otro repositorio.</p> : <>
        <p>Checkout contenido según opciones: {current.capability.has_local_checkout ? "sí" : "no"} · techo registrado {current.capability.project_sandbox_ceiling}.</p>
        {!current.capability.has_local_checkout && <p>Restricción registrada: falta checkout Git local contenido.</p>}
        {current.capability.agents.length === 0 && <p>Restricción registrada: no hay agentes configurados disponibles.</p>}
        <p>{current.capability.agents.some(agent => agent.modes.some(mode => mode.mode === "read-only" && mode.allowed)) ? "El registro ofrece análisis read-only para solicitar preview; no es un grant de ejecución." : "El registro no ofrece análisis read-only en esta lectura; revisá el motivo y la política en el formulario existente."}</p>
      </>}
      <p>Estas opciones no exponen fecha de observación y no reservan permisos. Perfil lógico, task kind, scope, consentimiento, presupuesto y sandbox efectivo se comprueban en el flujo protegido existente.</p>
    </section>}
    {current?.view && <details><summary>Evidencia local consultada y decisiones</summary>
      <p>Alineación canónica: {section("projects")?.rows.find(row => row.id === id)?.lineage.alignment ?? "no disponible en esta página"}. No se deduce de la configuración de agentes.</p>
      {(["projects", "issues", "executions", "workflows", "harness", "sessions"] as const).map(kind => { const source = section(kind); return source && <p key={kind}>{kind}: {source.source.availability} · {source.source.freshness} · cobertura {source.coverage} · observado {source.source.observed_at ?? "desconocido"} · total {source.total ?? "desconocido"}{source.has_more ? " · hay más registros fuera de esta página" : ""}.</p>; })}
      {issues.length === 0 && <p>Sin issue exacto disponible en esta página; no demuestra ausencia de bloqueos.</p>}
      <ul>{issues.map(issue => <li key={issue.id}>Issue {issue.id} · {issue.operating_state ?? issue.state} · candidato {issue.candidate_validity}.
        {(issue.operating_state === "blocked" || issue.operating_state === "needs-decision") && <> Motivo: {decisions[issue.decision_reason ?? "evidence-gap"] ?? decisions["evidence-gap"]}.</>}
        {onNavigate && <button type="button" className="ghost-btn" onClick={() => onNavigate({ kind: "issue", id: issue.id, projectId: id })}>Revisar issue {issue.id}</button>}</li>)}</ul>
      <ul>{workflows.filter(row => isSafeIdentifier(row.issue_id) && row.lineage.issue_id === row.issue_id && !row.lineage.gaps.includes("issue-unavailable")).map(row => <li key={row.id}>Workflow {row.id} · template {row.workflow_template_id ?? "no informado"} · {row.state}. {onNavigate && <button type="button" className="ghost-btn" onClick={() => onNavigate({ kind: "workflow", id: row.id, issueId: row.issue_id!, projectId: id })}>Revisar workflow {row.id}</button>}</li>)}</ul>
      <ul>{executions.map(row => <li key={row.id}>Tarea {row.id} · {row.state} / {row.result_status ?? "sin resultado"}. <button type="button" className="ghost-btn" onClick={() => onOpenTask(row.id)}>Inspeccionar tarea {row.id}</button></li>)}</ul>
      <p>Finalizar tareas, CI saludable y URLs no aceptan un issue ni prueban entrega. Revisá candidato exacto, checks y aceptación humana en el detalle existente.</p>
    </details>}
    <section aria-label="Circuito diario del proyecto">
      <h3>Circuito diario</h3>
      <ol><li>Seleccionar o registrar el proyecto e inspeccionar su evidencia.</li><li>Elegir o proponer un issue; revisar scope, perfil y consentimiento en su preview.</li><li>Autorizar explícitamente en el flujo existente; inspeccionar verificación y revisión del candidato exacto.</li><li>Registrar el resultado disponible y cerrar o pausar la sesión con un próximo paso. No implica entrega ni publicación.</li></ol>
      <div className="actions organization-form-actions" style={{ flexWrap: "wrap" }}>
        {onNavigate && <button type="button" className="ibtn" style={{ maxWidth: "100%", whiteSpace: "normal" }} onClick={() => onNavigate({ kind: "issues", projectId: id })}>Revisar o proponer issue</button>}
        <a className="ibtn" href={`#project-sessions-${id}`} style={{ maxWidth: "100%", whiteSpace: "normal" }}>Ir a la sesión del proyecto</a>
        <a className="ibtn" href={`#project-harness-${id}`} style={{ maxWidth: "100%", whiteSpace: "normal" }}>Inspeccionar detalle Harness existente</a>
      </div>
    </section>
    <p>Fase P: presupuesto productivo <b>not-enabled</b>; rutinas pendientes y continuidad/backup/restore/recovery <b>deferred</b>. No hay acciones de activación en este panel.</p>
  </section>;
}
