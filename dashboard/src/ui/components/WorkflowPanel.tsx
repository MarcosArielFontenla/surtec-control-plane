import { useEffect, useRef, useState } from "react";
import type { IssueLineage, WorkIssue } from "../../../../lib/issues/types";
import type { ClientContextCategory, ClientContextOptions } from "../../../../lib/client-portfolio";
import { WORKFLOW_TEMPLATES, type WorkflowRoleId, type WorkflowTemplateId } from "../../../../lib/workflows/types";
import {
  controlWorkflow, decideWorkflow, getClientContextOptions, getContextRoles, getWorkIssue, getWorkflow, getWorkflows,
  previewWorkflow, startWorkflow, type ContextRole, type WorkflowDetail, type WorkflowPreview, type WorkflowPreviewRequest,
  offerPlannerRecovery, type PlannerRecoveryInput,
} from "../api";
import { ClientContextConsent, ContextManifestEvidence, contextDisplayText, matchingPreviewBudget } from "./ContextPreview";
import { BudgetSummary } from "./BudgetSummary";
import type { BudgetPreview } from "../../server/budget-service";

const LABELS: Record<WorkflowTemplateId, string> = { analysis: "Análisis", implementation: "Implementación con plan", "quality-review": "Revisión de candidato", "operations-investigation": "Investigación operativa", "trivial-change": "Cambio trivial" };
const DEFAULT_BUDGET = { max_tasks: 7, max_attempts: 10, max_runtime_ms: 900000, max_total_tokens: 100000 };
const MAX_BUDGET = { max_tasks: 7, max_attempts: 14, max_runtime_ms: 1800000, max_total_tokens: 300000 };
const TERMINAL = ["completed", "cancelled"];
const HASH = /^[a-f0-9]{64}$/;
const safe = contextDisplayText;
const ISSUE_OPERATING_LABELS: Partial<Record<WorkIssue["status"], string>> = {
  working: "Trabajando", checking: "Verificando", "needs-decision": "Necesita decisión",
  "ready-for-review": "Listo para revisión", done: "Hecho", blocked: "Bloqueado",
};
const DECISION_TRIGGERS: Record<WorkflowDetail["decisions"][number]["kind"], string> = {
  "plan-approval": "Aprobación del plan exacto",
  "scope-authorization": "Autorización de una revisión de alcance",
  "candidate-acceptance": "Aceptación humana del candidato exacto",
  "risk-acknowledgement": "Reconocimiento humano de riesgos registrados",
  "proposal-acknowledgement": "Revisión humana de la propuesta registrada",
  recovery: "Revisión humana de recuperación",
  replacement: "Revisión humana de reemplazo",
};
function selectedRoles(template: WorkflowTemplateId, analysis: "portfolio-analyst" | "planner", qa: boolean): WorkflowRoleId[] {
  if (template === "analysis") return [analysis];
  if (template === "operations-investigation") return ["operations-observer"];
  if (template === "quality-review") return ["reviewer", "qa-evaluator"];
  return [...(template === "implementation" ? ["planner" as const] : []), "software-engineer", "reviewer", ...(qa ? ["qa-evaluator" as const] : [])];
}
function currentCandidate(detail: WorkflowDetail, lineage: IssueLineage): boolean {
  const binding = detail.workflow.candidate, issue = lineage.issue;
  if (!binding) return false;
  const candidate = lineage.candidates.find((entry) => entry.id === binding.candidate_id);
  return Boolean(candidate && issue.candidate_ids.at(-1) === candidate.id && candidate.invalidated_at === null
    && issue.scope_revision === binding.scope_revision && detail.workflow.scope_revision === binding.scope_revision
    && candidate.scope_revision === binding.scope_revision && candidate.task_id === binding.task_id && candidate.execution_id === binding.execution_id
    && candidate.base_revision === binding.base_revision && candidate.candidate_revision === binding.candidate_revision && candidate.diff_fingerprint === binding.diff_fingerprint);
}
function matchesPreview(preview: WorkflowPreview, request: WorkflowPreviewRequest): boolean {
  const actual = preview.request;
  const sameCategories = (categories: unknown, role: WorkflowRoleId) => Array.isArray(categories)
    && JSON.stringify([...categories].sort()) === JSON.stringify([...(request.client_context_categories[role] ?? [])].sort());
  return preview.schema_version === 1 && typeof preview.allowed === "boolean" && HASH.test(preview.fingerprint)
    && preview.issue_revision === request.expected_revision && actual?.issue_id === request.issue_id && actual.project_id === request.project_id
    && actual.template_id === request.template_id && actual.template_version === 1 && actual.expected_revision === request.expected_revision
    && actual.analysis_role === request.analysis_role && actual.candidate_id === request.candidate_id && actual.correction_enabled === request.correction_enabled
    && Object.keys(DEFAULT_BUDGET).every((key) => actual.budget?.[key as keyof typeof DEFAULT_BUDGET] === request.budget?.[key as keyof typeof DEFAULT_BUDGET])
    && actual.selected_agents && Object.keys(actual.selected_agents).length === Object.keys(request.selected_agents).length
    && actual.client_context_categories && Object.keys(actual.client_context_categories).length === Object.keys(request.selected_agents).length
    && Array.isArray(preview.role_assignments) && preview.role_assignments.length === Object.keys(request.selected_agents).length
    && Object.entries(request.selected_agents).every(([role, agent]) => actual.selected_agents[role as WorkflowRoleId] === agent
      && sameCategories(actual.client_context_categories[role as WorkflowRoleId], role as WorkflowRoleId)
      && preview.role_assignments.some((entry) => entry.role_id === role && entry.agent_id === agent
        && sameCategories(entry.client_context_categories, role as WorkflowRoleId)))
    && Array.isArray(preview.roles) && preview.roles.length === preview.role_assignments.length
    && new Set(preview.roles.map((entry) => entry.role_id)).size === preview.role_assignments.length
    && preview.roles.every((entry) => entry.manifest?.schema_version === 1 && entry.manifest.project_id === request.project_id
      && entry.manifest.role_id === entry.role_id && entry.manifest.agent_id === request.selected_agents[entry.role_id]
      && sameCategories(entry.manifest.selected_categories, entry.role_id));
}
function Notes({ items }: { items: string[] }) {
  return items.length ? <ul className="detail-list">{items.map((item, index) => <li key={index}>{safe(item)}</li>)}</ul> : <p className="work-issue-note">Sin registros.</p>;
}

function roleBudgetPreview(preview: WorkflowPreview, role: WorkflowRoleId): BudgetPreview | null {
  const entries = preview.budget_previews;
  if (!Array.isArray(entries) || entries.length !== preview.roles.length || entries.length > 6
    || new Set(entries.map((entry) => entry?.role_id)).size !== entries.length
    || entries.some((entry) => !entry || !preview.roles.some((assignment) => assignment.role_id === entry.role_id))) return null;
  // The combined projection already intersects role/root/correction constraints.
  // A missing combined field never falls back to a less restrictive role view.
  return matchingPreviewBudget(entries.find((entry) => entry.role_id === role)?.workflow_preview, preview.request.project_id, role, preview.request.issue_id);
}

function WorkflowEvidence({ detail, lineage, onOpenTask }: { detail: WorkflowDetail; lineage: IssueLineage; onOpenTask?: (id: string) => void }) {
  const owner = detail.workflow, stage = detail.stages.find((entry) => entry.id === owner.current_stage_id), binding = owner.candidate;
  const pendingDecision = detail.decisions.find((entry) => entry.id === owner.pending_decision_id && entry.status === "pending");
  const decisionTrigger = pendingDecision && Object.hasOwn(DECISION_TRIGGERS, pendingDecision.kind) ? `${DECISION_TRIGGERS[pendingDecision.kind]} · ${pendingDecision.kind} · ${safe(pendingDecision.id)}` : null;
  const operatingState = owner.status === "running" ? stage?.phase === "verification" || stage?.kind === "review" || stage?.kind === "qa" ? "Verificando" : "Trabajando"
    : owner.status === "waiting-human" || owner.status === "needs-decision" ? "Necesita decisión" : null;
  const writer = binding ? lineage.tasks.find((entry) => entry.task.envelope.id === binding.task_id)?.task : null;
  const receipt = writer?.testing_evidence, valid = currentCandidate(detail, lineage);
  const evidence = lineage.evidence.filter((entry) => detail.stages.some((entryStage) => entryStage.task_id === entry.task_id) || entry.candidate_id === binding?.candidate_id);
  const correctionIds = new Set(detail.stages.filter((entry) => entry.kind === "correction" || entry.ordinal > (detail.stages.find((entry) => entry.kind === "correction")?.ordinal ?? Infinity)).map((entry) => entry.id));
  const charges = detail.accounting.filter((entry) => correctionIds.has(entry.stage_id));
  const correctionUsageKnown = Boolean(detail.lineage && owner.counters.accounting_complete && charges.every((entry) => entry.usage_complete)
    && (detail.lineage.corrections_consumed === 0 || detail.stages.some((entry) => entry.id === detail.lineage?.consumed_stage_id && entry.kind === "correction"))
    && detail.stages.filter((entry) => correctionIds.has(entry.id) && entry.execution_id).every((entry) => charges.some((charge) => charge.execution_id === entry.execution_id && charge.task_id === entry.task_id)));
  return <>
    <section className="workflow-decision" aria-label="Estado operativo y disparador del workflow">
      <h4>Estado operativo y decisión actual</h4>
      <dl className="detail-dl workflow-facts">
        <dt>Estado operativo del workflow</dt><dd>{operatingState ?? "Sin estado operativo activo"}</dd>
        <dt>Estado registrado del workflow</dt><dd>{owner.status}</dd>
        <dt>Estado del issue vinculado</dt><dd>{ISSUE_OPERATING_LABELS[lineage.issue.status] ?? "Sin etiqueta operativa"} · {lineage.issue.status}</dd>
        <dt>Disparador registrado</dt><dd>{pendingDecision ? decisionTrigger ?? "Brecha de evidencia: tipo de decisión no reconocido; no se infiere un disparador."
          : owner.blocked_reason ? "Bloqueo registrado; sin categoría inferida a partir de su texto."
          : operatingState === "Necesita decisión" ? "Brecha de evidencia: falta la decisión pendiente o el motivo registrado."
          : "Sin decisión pendiente registrada"}</dd>
        <dt>Bloqueo</dt><dd>{owner.blocked_reason ? safe(owner.blocked_reason) : "Sin bloqueo registrado"}</dd>
        <dt>Próxima acción permitida</dt><dd>{safe(owner.next_action)}</dd>
        <dt>Observación del workflow</dt><dd><time dateTime={owner.updated_at}>{owner.updated_at}</time></dd>
      </dl>
      {owner.pending_decision_id && !pendingDecision && <p className="work-issue-note">Brecha de evidencia: la referencia de decisión pendiente no tiene un registro pendiente disponible.</p>}
      {owner.status === "completed" && <p className="work-issue-note">Workflow finalizado. No implica issue Hecho, candidato vigente, aceptación técnica ni entrega.</p>}
      {owner.status === "cancelled" && <p className="work-issue-note">Workflow cancelado; no se convierte en Hecho ni elimina la evidencia retenida.</p>}
      {pendingDecision && owner.blocked_reason && <p className="work-issue-note">La decisión y el bloqueo son hechos independientes; ninguno sustituye los bindings ni habilita una acción.</p>}
      <p className="work-issue-note">Las etiquetas y la próxima acción registrada son orientativas, no una autorización. Las confirmaciones actuales se verifican por separado.</p>
    </section>
    <section className="workflow-evidence" aria-label="Alcance, clasificación y requisitos del workflow">
      <h4>Alcance, clasificación y requisitos</h4>
    <dl className="detail-dl workflow-facts">
      <dt>Workflow</dt><dd>{safe(owner.id)} · r{owner.revision} · autoridad r{owner.authority_revision}</dd>
      <dt>Template</dt><dd>{LABELS[owner.template_id]} · v{owner.template_version} · {owner.status}</dd>
      <dt>Etapa actual</dt><dd>{stage ? `${stage.kind} · ${stage.status} · ${stage.phase} · generación ${stage.generation}` : "Sin etapa activa"}</dd>
      <dt>Rol activo</dt><dd>{stage ? `${stage.role_id} → ${stage.agent_id} · ${stage.sandbox}` : "Sin rol activo"}</dd>
      <dt>Issue</dt><dd>{lineage.issue.status} · {owner.work_scale} · scope autorizado r{owner.scope_revision} · issue r{lineage.issue.revision}</dd>
      <dt>Clasificación registrada</dt><dd>{lineage.issue.work_scale} · {lineage.issue.criticality} · {lineage.issue.classification_inputs.affected_domains.map(safe).join(", ") || "Sin dominios registrados"}</dd>
      <dt>Asignación del issue</dt><dd>{lineage.issue.assigned_role_id ? safe(lineage.issue.assigned_role_id) : "Sin asignación registrada; no se infiere un permiso"}</dd>
      <dt>Alcance actual del issue</dt><dd>r{lineage.issue.scope_revision} · {lineage.issue.scope_revision === owner.scope_revision ? "Coincide con la revisión registrada del workflow" : "Revisiones diferentes; no se infiere autorización actual"}</dd>
      <dt>Recovery</dt><dd>{owner.recovery_state}</dd>
      <dt>Revisión</dt><dd>{owner.review_policy ? `intrínseca ${owner.review_policy.intrinsic_depth} · efectiva ${owner.review_policy.effective_depth} · QA ${owner.review_policy.qa_required ? "requerido" : "no requerido"}` : "Política no disponible; no se infiere aprobación"}</dd>
      <dt>Testing</dt><dd>{detail.grant.testing_mode} · mínimo {detail.grant.minimum_review_depth}</dd>
    </dl>
    <Notes items={lineage.issue.classification_rationale} />
    <Notes items={owner.review_policy?.reasons ?? []} />
    <p className="work-issue-note">Los requisitos registrados pertenecen a este workflow; no sustituyen una nueva evaluación de la política actual.</p>
    </section>
    <section className="workflow-evidence" aria-label="Candidato exacto y corrección acotada del workflow">
      <h4>Candidato exacto, consumo y corrección</h4>
    <dl className="detail-dl workflow-facts">
      <dt>Presupuesto raíz</dt><dd>{owner.counters.tasks}/{owner.budget.max_tasks} tareas · {owner.counters.attempts}/{owner.budget.max_attempts} intentos · {owner.counters.runtime_ms}/{owner.budget.max_runtime_ms} ms activos · {owner.counters.total_tokens}/{owner.budget.max_total_tokens} tokens</dd>
      <dt>Accounting</dt><dd>{owner.counters.accounting_complete ? "Completo" : "Incompleto; no se interpreta como consumo cero"}</dd>
      <dt>Corrección</dt><dd>{detail.grant.correction.enabled ? `Opt-in · ${detail.lineage?.corrections_consumed ?? "desconocido"}/${detail.grant.correction.max_corrections} consumida` : "Desactivada"}</dd>
      {detail.grant.correction.budget && <><dt>Subpresupuesto de corrección</dt><dd>{correctionUsageKnown
        ? `${detail.stages.filter((entry) => correctionIds.has(entry.id) && entry.task_id).length}/${detail.grant.correction.budget.max_tasks} tareas · ${charges.length}/${detail.grant.correction.budget.max_attempts} intentos · ${charges.reduce((sum, entry) => sum + entry.active_runtime_ms, 0)}/${detail.grant.correction.budget.max_runtime_ms} ms · ${charges.reduce((sum, entry) => sum + entry.observed_tokens, 0)}/${detail.grant.correction.budget.max_total_tokens} tokens`
        : `Consumo no confirmado; límites ${detail.grant.correction.budget.max_tasks} tareas · ${detail.grant.correction.budget.max_attempts} intentos · ${detail.grant.correction.budget.max_runtime_ms} ms · ${detail.grant.correction.budget.max_total_tokens} tokens`}; dentro de la raíz, no capacidad adicional</dd></>}
      <dt>Candidato</dt><dd>{binding ? `${binding.candidate_id} · ${valid ? "Vigente según registros" : "Invalidado, reemplazado o sin binding actual"}` : "Sin candidato; no se infiere validez"}</dd>
      {binding && <><dt>Commit / fingerprint</dt><dd>{binding.candidate_revision}<br />{binding.diff_fingerprint}<br />contenido {binding.content_fingerprint}</dd></>}
    </dl>
    <p className="work-issue-note">Los contadores son consumo observado; con accounting incompleto son parciales, no saldo disponible ni cero consumo desconocido.</p>
    <p className="work-issue-note">La validez mostrada corresponde a los registros. El servidor revalida el árbol Git, receipts y autoridad al ejecutar y decidir; este panel no demuestra que el árbol permanezca limpio.</p>
    </section>
    <details className="workflow-evidence"><summary>Etapas, roles y consentimiento aprobado</summary>
      {detail.grant.role_assignments.map((assignment) => <div key={assignment.role_id}><b>{assignment.role_id} → {assignment.agent_id}</b><p>{assignment.sandbox} · categorías: {assignment.client_context_categories.join(", ") || "ninguna"}</p></div>)}
      {detail.stages.map((entry) => <div key={entry.id}><b>{entry.ordinal}. {entry.kind} · {entry.status} · g{entry.generation}</b><p>{entry.role_id} · {entry.task_id ?? "sin tarea"}</p>
        {entry.task_id && onOpenTask && <button type="button" className="ibtn" onClick={() => onOpenTask(entry.task_id!)}>Ver tarea {entry.task_id}</button>}
        {entry.output && <><p>{safe(entry.output.summary)}</p>{entry.output.kind === "plan" && <Notes items={entry.output.plan} />}{entry.output.kind === "analysis" && <Notes items={entry.output.recommendations} />}
          {entry.output.kind === "operations" && entry.output.proposed_issue && <p>Propuesta solamente: {safe(entry.output.proposed_issue.title)} · {safe(entry.output.proposed_issue.expected_outcome)}</p>}
          <Notes items={entry.output.unresolved_questions} /><Notes items={entry.output.risks} /><p>{safe(entry.output.recommended_next_action)}</p>{entry.output.requested_decision && <p>Decisión solicitada: {safe(entry.output.requested_decision)}</p>}</>}
      </div>)}
    </details>
    <details className="workflow-evidence"><summary>Handoffs completados ({detail.handoffs.length})</summary>
      {detail.handoffs.map((handoff) => <div key={handoff.id}><b>{handoff.from_role_id} → {handoff.to_role_id}</b><p>{safe(handoff.outcome_summary)}</p><small>{handoff.id} · ejecución {handoff.execution_id} · evidencia {handoff.evidence_ids.join(", ") || "sin referencias"}</small><Notes items={handoff.unresolved_questions} /><Notes items={handoff.risks} /><p>{safe(handoff.recommended_next_action)}</p>{handoff.requested_decision && <p>{safe(handoff.requested_decision)}</p>}</div>)}
    </details>
    <details className="workflow-evidence"><summary>Evidencia, verificación y receipts ({evidence.length})</summary>
      <p className="work-issue-note">Las referencias pueden incluir evidencia histórica. Un receipt o un veredicto aislado no prueba aceptación ni vigencia del candidato actual.</p>
      {evidence.map((entry) => <div key={entry.id}><b>{entry.status} · {safe(entry.label)}</b><p>{entry.id} · {safe(entry.reference)}</p></div>)}
      {receipt ? <div><b>Receipt de testing · {receipt.mode}</b><p>{receipt.fingerprint} · ejecución {receipt.execution_id}</p>{receipt.observations.map((observation, index) => <p key={index}>{observation.stage} · {observation.outcome} · exit {observation.exit_code ?? "sin código"} · {observation.command_fingerprint}</p>)}</div> : <p>Sin receipt de testing capturado para el candidato; no se inventa un resultado.</p>}
      {detail.review_receipts.map((review) => <div key={review.id}><b>{review.role_id} · {review.verdict}</b><p>{review.id} · candidato {review.candidate.candidate_id} · {review.fingerprint}</p><p>Testing {review.candidate.testing_evidence_fingerprint} · contexto {review.context_fingerprint} · política {review.review_policy_fingerprint}</p><Notes items={review.findings.map((finding) => `${finding.severity}: ${finding.summary}${finding.path ? ` (${finding.path})` : ""}`)} /></div>)}
      <Notes items={lineage.evidence_gaps} />
    </details>
    <details className="workflow-evidence"><summary>Recovery, intents y eventos</summary>
      {owner.planner_recovery && <section aria-label="Procedencia humana del plan">
        <h4>Propuesta retenida de Planner</h4><p>Planner conserva su resultado needs-review. {owner.approved_plan ? "El plan exacto fue adoptado mediante aprobación humana." : "Una persona ofreció la propuesta; su aprobación exacta sigue pendiente."}</p>
        <p>{owner.planner_recovery.id} · {owner.planner_recovery.fingerprint}</p><p>{safe(owner.planner_recovery.rationale)}</p>
        {owner.planner_recovery.questions.map((question) => <p key={question.index}>Pregunta {question.index + 1}: {safe(question.answer)}</p>)}
        <p>Los riesgos reconocidos y el consumo original se conservan; este registro no acredita verificación ni aceptación del candidato.</p>
      </section>}
      <h4>Intentos y ejecuciones registrados</h4>
      {detail.accounting.length ? detail.accounting.map((entry) => <p key={entry.id}>{entry.task_id} · ejecución {entry.execution_id} · intento {entry.attempt} · etapa {entry.stage_id} · {entry.active_runtime_ms} ms · {entry.observed_tokens} tokens observados · {entry.usage_complete ? "registro completo" : "consumo incompleto; total desconocido"}</p>) : <p>Sin intentos de accounting registrados; no se infiere ejecución ni consumo cero.</p>}
      {detail.admission_intents.map((intent) => <p key={intent.id}>{intent.id} · {intent.status} · {intent.task_id} · {intent.blocked_reason ? safe(intent.blocked_reason) : "sin bloqueo"}</p>)}
      {detail.events.map((entry) => <p key={entry.id}>r{entry.revision} · {entry.type} · {safe(entry.summary)}</p>)}
    </details>
  </>;
}

function PlannerRecoveryControls({ detail, issueRevision, disabled, onRecover }: {
  detail: WorkflowDetail; issueRevision: number; disabled: boolean; onRecover: (input: PlannerRecoveryInput) => void;
}) {
  const [confirmed, setConfirmed] = useState(false), [rationale, setRationale] = useState("");
  const [answers, setAnswers] = useState<Record<number, string>>({}), [kinds, setKinds] = useState<Record<number, string>>({});
  const [risks, setRisks] = useState<number[]>([]);
  const offer = detail.planner_recovery_offer;
  if (!offer?.eligible) return null;
  const current = offer.workflow_revision === detail.workflow.revision && offer.issue_revision === issueRevision && HASH.test(offer.source_fingerprint);
  const ready = current && !disabled && confirmed && rationale.trim().length > 0 && rationale === safe(rationale)
    && offer.questions.every((q) => ["plan-approval-gate", "operator-clarification"].includes(kinds[q.index]) && answers[q.index]?.trim() && safe(answers[q.index]) === answers[q.index])
    && offer.risks.every((risk) => risks.includes(risk.index));
  return <section className="workflow-decision" aria-label="Recuperar propuesta de Planner">
    <h4>Ofrecer la propuesta retenida</h4><p>Planner terminó needs-review. Esta acción conserva su salida y consumo, y abre una aprobación del plan por separado. No inicia Engineer.</p>
    {offer.questions.map((q) => <fieldset key={q.index}><legend>{safe(q.text)}</legend>
      <label className="workflow-field">Resolución de pregunta {q.index + 1}<select aria-label={`Resolución de pregunta ${q.index + 1}`} value={kinds[q.index] ?? ""} disabled={disabled || !current} onChange={(e) => setKinds((previous) => ({ ...previous, [q.index]: e.target.value }))}>
        <option value="">Elegí la resolución</option><option value="plan-approval-gate">Aprobación en el siguiente gate</option><option value="operator-clarification">Aclaración sin cambiar el plan</option>
      </select></label>
      <label className="workflow-field">Respuesta a pregunta {q.index + 1}<textarea aria-label={`Respuesta a pregunta ${q.index + 1}`} maxLength={500} value={answers[q.index] ?? ""} disabled={disabled || !current} onChange={(e) => setAnswers((previous) => ({ ...previous, [q.index]: e.target.value }))} /></label>
    </fieldset>)}
    {offer.risks.map((risk) => <label className="work-issue-toggle" key={risk.index}><input type="checkbox" checked={risks.includes(risk.index)} disabled={disabled || !current} onChange={(e) => setRisks((previous) => e.target.checked ? [...previous, risk.index] : previous.filter((index) => index !== risk.index))} />Reconozco el riesgo: {safe(risk.text)}</label>)}
    <label className="workflow-field">Motivo de recuperación<textarea aria-label="Motivo de recuperación" maxLength={1000} value={rationale} disabled={disabled || !current} onChange={(e) => setRationale(e.target.value)} /></label>
    <label className="work-issue-toggle"><input type="checkbox" checked={confirmed} disabled={disabled || !current} onChange={(e) => setConfirmed(e.target.checked)} />Confirmo ofrecer este plan sin cambiar alcance, límites ni verificaciones</label>
    <button type="button" className="ibtn" disabled={!ready} onClick={() => { if (!ready) return; onRecover({ expected_revision: detail.workflow.revision, expected_issue_revision: issueRevision,
      source_fingerprint: offer.source_fingerprint, rationale,
      questions: offer.questions.map((q) => ({ index: q.index, fingerprint: q.fingerprint, kind: kinds[q.index] as "plan-approval-gate" | "operator-clarification", answer: answers[q.index] })),
      risks: offer.risks.map((risk) => ({ index: risk.index, fingerprint: risk.fingerprint })) }); }}>Ofrecer plan para aprobación</button>
  </section>;
}

export function WorkflowPanel({ issue, refreshKey = 0, initialWorkflowId, onChanged, onOpenTask }: {
  issue: WorkIssue; refreshKey?: number; initialWorkflowId?: string; onChanged: () => Promise<void>; onOpenTask?: (id: string) => void;
}) {
  const [epoch, setEpoch] = useState(0), [roles, setRoles] = useState<ContextRole[]>([]);
  const [consentOptions, setConsentOptions] = useState<ClientContextOptions | null>(null), [consentError, setConsentError] = useState<string | null>(null);
  const [template, setTemplate] = useState<WorkflowTemplateId>("analysis"), [analysisRole, setAnalysisRole] = useState<"portfolio-analyst" | "planner">("portfolio-analyst");
  const [qa, setQa] = useState(false), [correction, setCorrection] = useState(false), [budget, setBudget] = useState(DEFAULT_BUDGET);
  const [agents, setAgents] = useState<Partial<Record<WorkflowRoleId, string>>>({}), [categories, setCategories] = useState<Partial<Record<WorkflowRoleId, ClientContextCategory[]>>>({});
  const [owners, setOwners] = useState<WorkflowDetail["workflow"][] | null>(null), [selected, setSelected] = useState("");
  const [facts, setFacts] = useState<{ detail: WorkflowDetail; lineage: IssueLineage } | null>(null);
  const [readError, setReadError] = useState<string | null>(null), [actionError, setActionError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [previewState, setPreviewState] = useState<{ key: string; value: WorkflowPreview; at: number } | null>(null), [previewPending, setPreviewPending] = useState(false), [rootConfirmed, setRootConfirmed] = useState("");
  const [ack, setAck] = useState({ key: "", confirmed: false, rationale: "", criteria: [] as string[], stop: false, recover: false });
  const sequence = useRef(0), previews = useRef(0), selection = useRef(initialWorkflowId ?? ""), observedRevision = useRef(issue.revision), onChange = useRef(onChanged);
  const identity = useRef(JSON.stringify([issue.id, issue.project_id, initialWorkflowId]));
  onChange.current = onChanged;
  const resetKey = JSON.stringify([issue, refreshKey, epoch, initialWorkflowId]);

  useEffect(() => {
    const generation = ++sequence.current; previews.current++; observedRevision.current = issue.revision;
    const nextIdentity = JSON.stringify([issue.id, issue.project_id, initialWorkflowId]);
    if (identity.current !== nextIdentity) { identity.current = nextIdentity; selection.current = initialWorkflowId ?? ""; }
    setRoles([]); setAgents({}); setCategories({}); setConsentOptions(null); setConsentError(null); setTemplate("analysis"); setAnalysisRole("portfolio-analyst"); setQa(false); setCorrection(false); setBudget({ ...DEFAULT_BUDGET });
    setOwners(null); setFacts(null); setSelected(""); setReadError(null); setActionError(null); setBusy(false); setPreviewState(null); setPreviewPending(false); setRootConfirmed(""); setAck({ key: "", confirmed: false, rationale: "", criteria: [], stop: false, recover: false });
    getContextRoles(issue.project_id).then((value) => { if (sequence.current === generation) setRoles(value.roles); }).catch(() => { if (sequence.current === generation) setReadError("No se pudieron confirmar los roles actuales; no se habilita una acción."); });
    getClientContextOptions(issue.project_id).then((value) => { if (sequence.current === generation) setConsentOptions(value); }).catch(() => { if (sequence.current === generation) setConsentError("No se pudieron confirmar las opciones de consentimiento actuales."); });
    let loading = false;
    async function load() {
      if (loading) return; loading = true;
      try {
        const [list, lineage] = await Promise.all([getWorkflows(issue.id), getWorkIssue(issue.id)]);
        if (sequence.current !== generation) return;
        if (lineage.issue.id !== issue.id || lineage.issue.project_id !== issue.project_id || list.workflows.some((owner) => owner.issue_id !== issue.id || owner.project_id !== issue.project_id)) throw new Error("Workflow/issue binding mismatch; no action is enabled");
        const id = selection.current || list.workflows.find((owner) => !TERMINAL.includes(owner.status))?.id || list.workflows.at(-1)?.id || "";
        if (id && !list.workflows.some((owner) => owner.id === id)) throw new Error("Requested workflow is not owned by this issue");
        const detail = id ? await getWorkflow(id) : null;
        if (sequence.current !== generation || selection.current && selection.current !== id) return;
        if (detail && (detail.workflow.issue_id !== issue.id || detail.workflow.project_id !== issue.project_id)) throw new Error("Workflow detail belongs to another issue");
        setOwners(list.workflows); setSelected(id); setFacts(detail ? { detail, lineage } : null); setReadError(null);
        if (lineage.issue.revision !== observedRevision.current) { observedRevision.current = lineage.issue.revision; previews.current++; setPreviewState(null); setRootConfirmed(""); setCategories({}); void onChange.current(); }
      } catch { if (sequence.current === generation) { setReadError("No se pudieron confirmar el workflow y su evidencia actual; actualizá antes de decidir."); previews.current++; setPreviewState(null); setRootConfirmed(""); } }
      finally { loading = false; }
    }
    void load(); const timer = setInterval(() => void load(), 3000);
    return () => { sequence.current++; previews.current++; clearInterval(timer); };
  }, [resetKey]);

  const roleIds = selectedRoles(template, analysisRole, qa);
  const eligible = (id: WorkflowRoleId) => roles.find((role) => role.id === id)?.agents.filter((agent) => id !== "software-engineer" || agent === issue.assigned_role_id) ?? [];
  const selectedAgents = Object.fromEntries(roleIds.map((id) => [id, agents[id] ?? eligible(id)[0] ?? ""])) as WorkflowPreviewRequest["selected_agents"];
  const request: WorkflowPreviewRequest = { template_id: template, template_version: 1, project_id: issue.project_id, issue_id: issue.id, expected_revision: issue.revision,
    selected_agents: selectedAgents, client_context_categories: Object.fromEntries(roleIds.map((id) => [id, categories[id] ?? []])), correction_enabled: correction, budget,
    ...(template === "analysis" ? { analysis_role: analysisRole } : {}), ...(template === "quality-review" ? { candidate_id: issue.candidate_ids.at(-1) } : {}) };
  const requestKey = JSON.stringify(request), preview = previewState?.key === requestKey && Date.now() - previewState.at < 300000 ? previewState.value : null;
  const budgetValid = (Object.keys(MAX_BUDGET) as Array<keyof typeof MAX_BUDGET>).every((key) => Number.isSafeInteger(budget[key]) && budget[key] >= 1 && budget[key] <= MAX_BUDGET[key]);
  const activeOwner = owners?.find((owner) => !TERMINAL.includes(owner.status));
  const invalidate = () => { previews.current++; setPreviewState(null); setPreviewPending(false); setRootConfirmed(""); setActionError(null); };
  useEffect(() => { invalidate(); }, [requestKey]);
  const actionKey = facts ? JSON.stringify([facts.detail, facts.lineage.issue, facts.lineage.candidates, facts.lineage.evidence,
    facts.lineage.tasks.map((entry) => entry.task.testing_evidence?.fingerprint)]) : "";
  const acknowledgement = ack.key === actionKey ? ack : { key: actionKey, confirmed: false, rationale: "", criteria: [] as string[], stop: false, recover: false };
  const updateAck = (change: Partial<typeof ack>) => setAck((current) => ({ ...(current.key === actionKey ? current : acknowledgement), ...change, key: actionKey }));
  const decision = facts?.detail.decisions.find((entry) => entry.id === facts.detail.workflow.pending_decision_id && entry.status === "pending");
  const decisionCurrent = Boolean(facts && decision && facts.detail.workflow.status === "waiting-human" && !facts.detail.workflow.stop_requested_at
    && facts.detail.workflow.recovery_state === "none" && decision.expected_workflow_revision === facts.detail.workflow.revision && decision.expected_issue_revision === facts.lineage.issue.revision
    && HASH.test(decision.resource_fingerprint) && ["plan-approval", "proposal-acknowledgement", "risk-acknowledgement", "candidate-acceptance"].includes(decision.kind));
  const candidateCurrent = Boolean(facts && currentCandidate(facts.detail, facts.lineage) && decision?.candidate_id === facts.detail.workflow.candidate?.candidate_id);
  const criteriaConfirmed = Boolean(facts && facts.lineage.issue.acceptance_criteria.every((criterion) => acknowledgement.criteria.includes(criterion) && safe(criterion) === criterion));
  const canDecide = !busy && !readError && decisionCurrent && acknowledgement.confirmed && Boolean(acknowledgement.rationale.trim())
    && acknowledgement.rationale === safe(acknowledgement.rationale) && acknowledgement.rationale.length <= 1000;

  async function perform(operation: () => Promise<WorkflowDetail>) {
    const generation = sequence.current; invalidate(); setBusy(true); setAck({ key: "", confirmed: false, rationale: "", criteria: [], stop: false, recover: false });
    try { const next = await operation(); if (sequence.current !== generation) return; selection.current = next.workflow.id; await onChange.current(); if (sequence.current === generation) setEpoch((value) => value + 1); }
    catch { if (sequence.current === generation) { setActionError("No se pudo confirmar el resultado de la acción. Revisá los registros actuales; no se repite automáticamente."); setPreviewState(null); setRootConfirmed(""); setCategories({}); } }
    finally { if (sequence.current === generation) setBusy(false); }
  }

  return <section className="workflow-panel" aria-label={`Workflow de ${issue.title}`}>
    <div className="work-issues-heading"><div><h4>Workflow gobernado</h4><p>Secuencia finita con gates humanos. Completar o aceptar nunca publica, hace merge ni despliega.</p></div><button type="button" className="ghost-btn" disabled={busy} onClick={() => setEpoch((value) => value + 1)}>Actualizar workflow</button></div>
    {(readError || actionError) && <p role="alert" className="banner banner--warn">{readError ?? actionError}</p>}
    {owners === null && !readError && <p className="empty-mini">Consultando autoridad y evidencia…</p>}
    {owners && owners.length > 0 && <label className="workflow-field">Workflow registrado<select aria-label="Workflow registrado" value={selected} disabled={busy} onChange={(event) => { selection.current = event.target.value; setFacts(null); invalidate(); setEpoch((value) => value + 1); }}>{owners.map((owner) => <option key={owner.id} value={owner.id}>{LABELS[owner.template_id]} · {owner.status} · {owner.id}</option>)}</select></label>}
    {facts && <>
      <WorkflowEvidence detail={facts.detail} lineage={facts.lineage} onOpenTask={onOpenTask} />
      <PlannerRecoveryControls key={`${actionKey}:${busy}`} detail={facts.detail} issueRevision={facts.lineage.issue.revision} disabled={busy || Boolean(readError) || !facts.detail.execution_enabled}
        onRecover={(input) => void perform(async () => {
          try { return await offerPlannerRecovery(facts.detail.workflow.id, input); }
          catch (error) { setFacts(null); setReadError("Resultado de recuperación desconocido. Actualizá el workflow antes de decidir; no se repite la solicitud."); throw error; }
        })} />
      <BudgetSummary projectId={issue.project_id} refreshKey={JSON.stringify([resetKey, facts.detail.workflow.id, facts.detail.workflow.revision])}
        title="Presupuesto actual del proyecto vinculado al workflow" />
      <p className="work-issue-note">Esta lectura tiene alcance de proyecto; no demuestra capacidad disponible para este workflow, su etapa o su candidato exactos.</p>
      <div className="workflow-decision">
        <h4>Decisión pendiente</h4><p>{decision ? `${decision.kind} · ${safe(decision.summary)}` : "Sin decisión ejecutable; no se confirma ni recupera automáticamente."}</p>
        {decision && <><p className="work-issue-note">{decision.id} · issue r{decision.expected_issue_revision} · workflow r{decision.expected_workflow_revision} · {decision.resource_fingerprint}</p>
          {decision.kind === "plan-approval" && <p>Revisá la propuesta del Planner en las etapas. Aprobar no cambia el plan, los criterios ni el scope del issue.</p>}
          {decision.kind === "risk-acknowledgement" && <p>Reconocer riesgos no omite verificación fallida, hallazgos bloqueantes ni evidencia obsoleta.</p>}
          {decision.kind === "candidate-acceptance" && <fieldset className="workflow-criteria"><legend>Criterios sobre el candidato exacto</legend>{facts.lineage.issue.acceptance_criteria.map((criterion) => <label key={criterion}><input type="checkbox" checked={acknowledgement.criteria.includes(criterion)} disabled={!decisionCurrent || busy || !candidateCurrent || Boolean(readError)} onChange={(event) => updateAck({ criteria: event.target.checked ? [...acknowledgement.criteria, criterion] : acknowledgement.criteria.filter((item) => item !== criterion) })} />{safe(criterion)}</label>)}</fieldset>}
          <label className="workflow-field">Motivo de la decisión<textarea aria-label="Motivo de la decisión" value={acknowledgement.rationale} disabled={!decisionCurrent || busy || Boolean(readError)} maxLength={1000} onChange={(event) => updateAck({ rationale: event.target.value })} /></label>
          <label className="work-issue-toggle"><input type="checkbox" checked={acknowledgement.confirmed} disabled={!decisionCurrent || busy || Boolean(readError)} onChange={(event) => updateAck({ confirmed: event.target.checked })} />Revisé esta decisión y sus bindings actuales</label>
          {!decisionCurrent && <p className="work-issue-note">Decisión no disponible o desactualizada. Actualizá; no se infiere una autorización.</p>}
          <div className="actions"><button type="button" className="ibtn primary" disabled={!canDecide || (decision.kind === "candidate-acceptance" && (!candidateCurrent || !criteriaConfirmed))} onClick={() => {
            if (!canDecide || decision.kind === "candidate-acceptance" && (!candidateCurrent || !criteriaConfirmed)) return;
            void perform(() => decideWorkflow(facts.detail.workflow.id, { expected_revision: facts.detail.workflow.revision, expected_issue_revision: facts.lineage.issue.revision,
              decision_id: decision.id, resource_fingerprint: decision.resource_fingerprint, decision: "approve", rationale: acknowledgement.rationale,
              ...(decision.kind === "candidate-acceptance" ? { confirmed_criteria: acknowledgement.criteria } : {}) }));
          }}>Aprobar decisión exacta</button><button type="button" className="ibtn" disabled={!canDecide} onClick={() => void perform(() => decideWorkflow(facts.detail.workflow.id, { expected_revision: facts.detail.workflow.revision, expected_issue_revision: facts.lineage.issue.revision, decision_id: decision.id, resource_fingerprint: decision.resource_fingerprint, decision: "reject", rationale: acknowledgement.rationale }))}>Rechazar decisión exacta</button></div>
        </>}
      </div>
      {!TERMINAL.includes(facts.detail.workflow.status) && <div className="workflow-decision">
        {!facts.detail.execution_enabled && <p>Controlador no disponible. Stop y recovery requieren el controlador; no se habilita ejecución desde la UI.</p>}
        <label className="work-issue-toggle"><input type="checkbox" checked={acknowledgement.stop} disabled={busy || !facts.detail.execution_enabled || Boolean(readError) || Boolean(facts.detail.workflow.stop_requested_at)} onChange={(event) => updateAck({ stop: event.target.checked })} />Confirmo detener este workflow y conservar su evidencia</label>
        <button type="button" className="ibtn" disabled={busy || !facts.detail.execution_enabled || Boolean(readError) || !acknowledgement.stop || Boolean(facts.detail.workflow.stop_requested_at)} onClick={() => void perform(() => controlWorkflow(facts.detail.workflow.id, "cancel", facts.detail.workflow.revision, facts.lineage.issue.revision))}>Detener workflow</button>
        {facts.detail.workflow.recovery_state !== "none" && <><label className="work-issue-toggle"><input type="checkbox" checked={acknowledgement.recover} disabled={busy || !facts.detail.execution_enabled || Boolean(readError)} onChange={(event) => updateAck({ recover: event.target.checked })} />Revisé los facts retenidos; reconciliar sin crear otro intento</label><button type="button" className="ibtn" disabled={busy || !facts.detail.execution_enabled || Boolean(readError) || !acknowledgement.recover} onClick={() => void perform(() => controlWorkflow(facts.detail.workflow.id, "recover", facts.detail.workflow.revision, facts.lineage.issue.revision))}>Reconciliar workflow</button></>}
      </div>}
      <p className="work-issue-note">{safe(facts.detail.runtime_read_limitation)}</p>
    </>}
    {owners !== null && !activeOwner && !["done", "cancelled"].includes(issue.status) && <details className="workflow-create" open={owners.length === 0}><summary>Preparar nuevo workflow</summary>
      <label className="workflow-field">Template<select aria-label="Template de workflow" value={template} disabled={busy} onChange={(event) => { invalidate(); setTemplate(event.target.value as WorkflowTemplateId); setCategories({}); setAgents({}); setCorrection(false); setQa(false); }}>
        {WORKFLOW_TEMPLATES.map((id) => <option key={id} value={id} disabled={id === "trivial-change" && issue.work_scale !== "trivial" || id === "quality-review" && !issue.candidate_ids.length}>{LABELS[id]}</option>)}
      </select></label>
      {template === "analysis" && <label className="workflow-field">Rol de análisis<select aria-label="Rol de análisis" value={analysisRole} disabled={busy} onChange={(event) => { invalidate(); setAnalysisRole(event.target.value as typeof analysisRole); setCategories({}); setAgents({}); }}><option value="portfolio-analyst">Portfolio Analyst</option><option value="planner">Planner</option></select></label>}
      {["implementation", "trivial-change"].includes(template) && <>
        <p className="work-issue-note">Escritura solo con scope autorizado y el ingeniero asignado al issue. El preview determina revisión y QA, no esta selección.</p>
        <label className="work-issue-toggle"><input type="checkbox" checked={qa} disabled={busy} onChange={(event) => { invalidate(); setQa(event.target.checked); setCategories({}); }} />Incluir el perfil QA requerido por la política</label>
        <label className="work-issue-toggle"><input type="checkbox" checked={correction} disabled={busy} onChange={(event) => { invalidate(); setCorrection(event.target.checked); }} />Autorizar hasta una corrección acotada dentro del presupuesto raíz</label>
      </>}
      <p className="work-issue-note">Sin categorías compartidas por defecto. El consentimiento es independiente para cada rol; no se hereda aunque use el mismo agente.</p>
      <div className="workflow-role-grid">{roleIds.map((id) => <fieldset key={id} className="workflow-role"><legend>{roles.find((role) => role.id === id)?.display_name ?? id}</legend>
        <label className="workflow-field">Agente de {id}<select aria-label={`Agente de ${id}`} value={selectedAgents[id]} disabled={busy || id === "software-engineer" || !eligible(id).length} onChange={(event) => { invalidate(); setAgents((current) => ({ ...current, [id]: event.target.value })); setCategories((current) => ({ ...current, [id]: [] })); }}><option value="" disabled>Sin agente compatible</option>{eligible(id).map((agent) => <option key={agent} value={agent}>{agent}</option>)}</select></label>
        <ClientContextConsent options={consentOptions} categories={categories[id] ?? []} onChange={(value) => { invalidate(); setCategories((current) => ({ ...current, [id]: value })); }} disabled={busy} error={consentError} />
      </fieldset>)}</div>
      <div className="organization-form-grid">{(Object.keys(DEFAULT_BUDGET) as Array<keyof typeof DEFAULT_BUDGET>).map((key) => <label key={key} className="workflow-field">{({ max_tasks: "Máximo de tareas", max_attempts: "Máximo de intentos", max_runtime_ms: "Runtime activo máximo (ms)", max_total_tokens: "Tokens máximos" })[key]}<input type="number" value={budget[key]} min={1} max={MAX_BUDGET[key]} disabled={busy} onChange={(event) => { invalidate(); setBudget((current) => ({ ...current, [key]: Number(event.target.value) })); }} /></label>)}</div>
      {preview && <section className="workflow-preview" aria-label="Preview de workflow"><h4>Preview de workflow</h4><p role="status">{preview.allowed ? "Workflow habilitado para este pedido." : "Workflow bloqueado; no se puede iniciar."}</p><Notes items={preview.blocked_reasons} />
        <p>{preview.plan.stages.map((stage) => stage.role_id).join(" → ")} · gate final {preview.plan.final_human_gate}</p><p>Scope r{preview.scope_revision} · issue r{preview.issue_revision} · revisión {preview.review_policy.effective_depth} · QA {preview.review_policy.qa_required ? "requerido" : "no requerido"} · testing {preview.testing_mode}</p>
        <Notes items={preview.review_policy.reasons} /><p>{preview.budget.max_tasks} tareas · {preview.budget.max_attempts} intentos · {preview.budget.max_runtime_ms} ms · {preview.budget.max_total_tokens} tokens · corrección {preview.correction.enabled ? "opt-in (máximo una)" : "desactivada"}</p>
        {preview.correction.budget && <p>Corrección: {preview.correction.budget.max_tasks} tareas · {preview.correction.budget.max_attempts} intentos · {preview.correction.budget.max_runtime_ms} ms · {preview.correction.budget.max_total_tokens} tokens, descontados de la raíz.</p>}
        <p className="work-issue-note">Cada presupuesto informativo por rol ya intersecta los límites aplicables del workflow. Son vistas superpuestas; no se suman para calcular consumo ni capacidad adicional.</p>
        {preview.roles.map((role) => <BudgetSummary key={role.role_id} budget={roleBudgetPreview(preview, role.role_id)}
          title={`Presupuesto informativo del workflow · ${role.role_id}`} />)}
        {preview.roles.map((role) => <details key={role.role_id}><summary>Contexto atribuido de {role.role_id}</summary><ContextManifestEvidence manifest={role.manifest} /></details>)}<p className="work-issue-note">{safe(preview.runtime_read_limitation)}</p><p className="work-issue-note">Previsualizar no crea tareas ni reserva capacidad. La confirmación permite solo la secuencia mostrada; gates humanos y revalidación siguen vigentes.</p>
      </section>}
      <label className="work-issue-toggle"><input type="checkbox" checked={Boolean(preview && rootConfirmed === requestKey)} disabled={!preview?.allowed || busy || Boolean(readError)} onChange={(event) => setRootConfirmed(event.target.checked ? requestKey : "")} />Apruebo este template, roles, scope, consentimiento y presupuesto exactos</label>
      <div className="actions"><button type="button" className="ibtn" disabled={busy || previewPending || Boolean(readError) || !budgetValid || roleIds.some((id) => !eligible(id).includes(selectedAgents[id] ?? ""))} onClick={() => {
        const attempt = ++previews.current; setPreviewPending(true); setPreviewState(null); setRootConfirmed(""); setActionError(null);
        void previewWorkflow(request).then((value) => { if (attempt !== previews.current) return; if (!matchesPreview(value, request)) throw new Error("Unsupported or mismatched workflow preview; regenerate before approval"); setPreviewState({ key: requestKey, value, at: Date.now() }); })
          .catch(() => { if (attempt === previews.current) setActionError("No se pudo confirmar el preview actual. Generá uno nuevo antes de aprobar."); }).finally(() => { if (attempt === previews.current) setPreviewPending(false); });
      }}>{previewPending ? "Previsualizando workflow…" : "Previsualizar workflow"}</button><button type="button" className="ibtn primary" disabled={busy || previewPending || Boolean(readError) || !preview?.allowed || rootConfirmed !== requestKey} onClick={() => { if (preview?.allowed && rootConfirmed === requestKey && !busy && !readError) void perform(() => startWorkflow(request, preview.fingerprint)); }}>Iniciar workflow aprobado</button></div>
    </details>}
    {activeOwner && !facts && <p>Hay un workflow activo. Sus decisiones se mantienen bloqueadas hasta cargar el detalle actual.</p>}
  </section>;
}
