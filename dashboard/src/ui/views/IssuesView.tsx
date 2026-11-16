import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { Inbox } from "../../../../lib/state/types";
import type { IssueCreateInput, IssueLineage, WorkIssue } from "../../../../lib/issues/types";
import type { OrganizationSnapshot } from "../../../../lib/organization";
import type { ClientContextCategory, ClientContextOptions } from "../../../../lib/client-portfolio";
import type { GovernedWorkflow } from "../../../../lib/workflows/types";
import {
  acceptWorkIssueCandidate, approveWorkIssueScope, authorizeWorkIssue, createWorkIssue,
  dispatchWorkIssue, fetchDispatchOptions, getInbox, getOrganization, getWorkIssue, getWorkIssues, rejectWorkIssueScope, resumeWorkIssue,
  resolveWorkIssueDecision, getContextRoles, getClientContextOptions, getWorkflows, type ContextRole, type DispatchOptions, type ManualIssueCreateInput,
} from "../api";
import { relativeTime } from "../relative-time";
import { ClientContextConsent, ContextPreview, contextDisplayText, useContextPreview } from "../components/ContextPreview";
import { WorkflowPanel } from "../components/WorkflowPanel";
import { BudgetSummary } from "../components/BudgetSummary";
import { DeliveryReadinessPanel } from "../components/DeliveryReadinessPanel";

function lines(value: string): string[] { return value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean); }
function words(value: string): string[] { return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean); }

const PENDING_ISSUE_REQUEST_KEY = "surtec.work-issue.pending-request.v1";
const REQUEST_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
interface PendingIssueIntake { requestId: string | null; payload: ManualIssueCreateInput | null }
interface IntakeReadBinding { requestId: string | null; generation: number }

function savedIntake(): PendingIssueIntake | null {
  try {
    const id = sessionStorage.getItem(PENDING_ISSUE_REQUEST_KEY);
    return id === null ? null : { requestId: REQUEST_UUID.test(id) ? id : null, payload: null };
  } catch { return { requestId: null, payload: null }; }
}

function matchesIntake(value: unknown, id: string, payload: ManualIssueCreateInput | null): value is WorkIssue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const issue = value as WorkIssue, receipt = issue.intake_receipt;
  return issue.schema_version === 1 && /^I-[a-f0-9-]{36}$/i.test(issue.id) && typeof issue.project_id === "string"
    && Number.isSafeInteger(issue.revision) && issue.revision >= 1
    && receipt?.schema_version === 1 && receipt.request_id === id && /^[a-f0-9]{64}$/.test(receipt.request_fingerprint)
    && (payload === null || issue.project_id === payload.project_id.trim());
}

/** UI identity only: no approval, dispatch, or durable payload storage. */
function useIssueIntake(onConfirmed: (issue: WorkIssue) => void) {
  const [pending, setPending] = useState<PendingIssueIntake | null>(savedIntake);
  const current = useRef(pending), generation = useRef(0), posting = useRef(false), reading = useRef(false);
  const [sending, setSending] = useState(false), [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null), [confirmedId, setConfirmedId] = useState<string | null>(null);
  const [cancelAcknowledged, setCancelAcknowledged] = useState(false);
  useEffect(() => () => { generation.current++; }, []);

  function remember(value: PendingIssueIntake) {
    current.current = value; setPending(value); setCancelAcknowledged(false);
  }
  function clearStoredIdentity(id: string | null) {
    const stored = sessionStorage.getItem(PENDING_ISSUE_REQUEST_KEY);
    if (stored !== null && (id === null ? REQUEST_UUID.test(stored) : stored !== id)) throw new Error("Pending identity changed");
    if (stored !== null) sessionStorage.removeItem(PENDING_ISSUE_REQUEST_KEY);
    if (sessionStorage.getItem(PENDING_ISSUE_REQUEST_KEY) !== null) throw new Error("Pending identity was not cleared");
  }
  const complete = useCallback((issue: unknown, id: string): boolean => {
    const request = current.current;
    if (request?.requestId !== id || !matchesIntake(issue, id, request.payload)) {
      setMessage("La respuesta no confirma la identidad del pedido. Comprobá el intento pendiente."); return false;
    }
    setConfirmedId(issue.id);
    try { clearStoredIdentity(id); }
    catch { setMessage("El pedido está confirmado, pero no se pudo cerrar su identidad guardada. Comprobá el intento antes de crear otro."); return false; }
    current.current = null; setPending(null); setMessage(null); setCancelAcknowledged(false);
    onConfirmed(issue); return true;
  }, [onConfirmed]);
  const capture = useCallback((): IntakeReadBinding => ({ requestId: current.current?.requestId ?? null, generation: generation.current }), []);
  const observe = useCallback((collection: { issues: WorkIssue[] }, binding: IntakeReadBinding) => {
    if (!binding.requestId || binding.generation !== generation.current || posting.current || current.current?.requestId !== binding.requestId) return;
    try {
      if (!Array.isArray(collection.issues) || collection.issues.length > 500) throw new Error("Incomplete issue collection");
      const found = collection.issues.filter((issue) => issue.intake_receipt?.request_id === binding.requestId);
      if (found.length === 1) { complete(found[0], binding.requestId); return; }
    } catch { /* A missing or invalid observation is not proof of non-creation. */ }
    setMessage("No se pudo confirmar el pedido en esta lectura. Su ausencia no demuestra que no se haya creado.");
  }, [complete]);

  async function send(request: PendingIssueIntake): Promise<boolean> {
    if (posting.current || reading.current || !request.requestId || !request.payload || current.current !== request) return false;
    try {
      const stored = sessionStorage.getItem(PENDING_ISSUE_REQUEST_KEY);
      if (stored !== null && stored !== request.requestId) throw new Error("Pending identity changed");
      sessionStorage.setItem(PENDING_ISSUE_REQUEST_KEY, request.requestId);
      if (sessionStorage.getItem(PENDING_ISSUE_REQUEST_KEY) !== request.requestId) throw new Error("Pending identity was not retained");
    } catch { setMessage("No se pudo conservar la identidad del pedido. No se envió la solicitud; comprobá el intento pendiente."); return false; }
    const attempt = ++generation.current;
    posting.current = true; setSending(true); setMessage(null); setCancelAcknowledged(false);
    try {
      const result = await createWorkIssue(structuredClone(request.payload));
      if (attempt !== generation.current || current.current?.requestId !== request.requestId) return false;
      return complete(result?.issue, request.requestId);
    } catch {
      if (attempt === generation.current && current.current?.requestId === request.requestId) {
        setMessage("No se pudo confirmar la creación. Conservamos el mismo pedido para comprobarlo o reintentarlo sin duplicarlo.");
      }
      return false;
    } finally { if (attempt === generation.current) { posting.current = false; setSending(false); } }
  }
  async function submit(payload: IssueCreateInput): Promise<boolean> {
    if (current.current || posting.current || reading.current) return false;
    try {
      const saved = savedIntake();
      if (saved) { remember(saved); setMessage("Hay una identidad pendiente que debe resolverse antes de crear otro pedido."); return false; }
      const id = crypto.randomUUID();
      if (!REQUEST_UUID.test(id)) throw new Error("Request identity is unavailable");
      const request = { requestId: id, payload: { ...structuredClone(payload), request_id: id } };
      remember(request); setConfirmedId(null);
      return send(request);
    } catch {
      remember({ requestId: null, payload: null }); setMessage("No se pudo preparar una identidad segura. No se envió ningún pedido."); return false;
    }
  }
  async function check() {
    if (posting.current || reading.current || !current.current) return;
    let id = current.current.requestId;
    if (!id) {
      const saved = savedIntake();
      if (!saved?.requestId) { setMessage("La identidad guardada no está disponible o no es válida. Revisá el aviso antes de cancelar el intento."); return; }
      remember(saved); id = saved.requestId;
    }
    const binding = { requestId: id, generation: ++generation.current };
    reading.current = true; setChecking(true); setMessage(null);
    try { const collection = await getWorkIssues(); observe(collection, binding); }
    catch { if (binding.generation === generation.current) setMessage("No se pudo leer el estado del pedido. El resultado sigue sin confirmar."); }
    finally { if (binding.generation === generation.current) { reading.current = false; setChecking(false); } }
  }
  function cancel() {
    if (!cancelAcknowledged || posting.current || !current.current) return;
    try { clearStoredIdentity(current.current.requestId); }
    catch { setMessage("No se pudo cerrar la identidad guardada o cambió. Recargá para revisarla; no se crea otro pedido."); return; }
    generation.current++; reading.current = false; setChecking(false);
    current.current = null; setPending(null); setMessage(null); setCancelAcknowledged(false);
  }
  return { pending, sending, checking, message, confirmedId, cancelAcknowledged, setCancelAcknowledged,
    submit, retry: () => current.current ? send(current.current) : Promise.resolve(false), check, cancel, capture, observe };
}

const operatingLabels: Partial<Record<WorkIssue["status"], string>> = {
  working: "Trabajando", checking: "Verificando", "needs-decision": "Necesita decisión",
  "ready-for-review": "Listo para revisión", done: "Hecho", blocked: "Bloqueado",
};

function IssueScope({ issue }: { issue: WorkIssue }) {
  const scope = issue.authorized_scope;
  return <details className="work-issue-scope">
    <summary>Scope y clasificación · revisión {issue.scope_revision}</summary>
    <p><b>Permitido:</b> {scope.allowed_path_patterns.join(", ")} · {scope.allowed_change_categories.join(", ")}</p>
    <p><b>Paths excluidos:</b> {scope.excluded_path_patterns.join(", ") || "ninguno registrado"}</p>
    <p><b>Exclusiones explícitas:</b> {scope.explicit_exclusions.join(" · ") || "ninguna registrada"}</p>
    <p><b>Resultado del scope:</b> {scope.expected_outcome}</p>
    <p><b>Criterios registrados:</b> {scope.acceptance_criteria.join(" · ")}</p>
    <p><b>Clasificación:</b> {issue.work_scale} · {issue.classification_rationale.join(" · ") || "sin justificación registrada"}</p>
    <p><b>Dominios:</b> {issue.classification_inputs.affected_domains.join(", ") || "no registrados"} · Migración: {issue.classification_inputs.requires_migration ? "sí" : "no"} · Seguridad: {issue.classification_inputs.security_impact ? "sí" : "no"}</p>
    <p><b>Plan:</b> {issue.plan.join(" → ") || "sin plan registrado"}</p>
    <p className="work-issue-note">Estos son datos del scope registrado, no una autorización nueva ni una prueba de vigencia Git.</p>
  </details>;
}

function IssueDispatch({ issue, options, busy, perform }: {
  issue: WorkIssue; options: DispatchOptions | null; busy: boolean;
  perform: (operation: () => Promise<unknown>) => Promise<void>;
}) {
  const [roles, setRoles] = useState<ContextRole[]>([]);
  const [roleId, setRoleId] = useState("");
  const [agent, setAgent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [consentOptions, setConsentOptions] = useState<ClientContextOptions | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [categories, setCategories] = useState<ClientContextCategory[]>([]);
  const project = options?.projects.find((entry) => entry.project === issue.project_id);
  const eligibleAgents = project?.agents.filter((entry) => entry.allowed_modes.includes("workspace-write")
    && (!issue.assigned_role_id || entry.agent === issue.assigned_role_id)).map((entry) => entry.agent) ?? [];
  const eligibility = JSON.stringify(eligibleAgents);

  useEffect(() => {
    let active = true;
    setRoles([]); setRoleId(""); setAgent(""); setCategories([]); setError(null);
    setConsentOptions(null); setConsentError(null);
    getContextRoles(issue.project_id).then(({ roles: available }) => {
      if (!active) return;
      const allowed = available.filter((role) => role.sandbox_ceiling === "workspace-write" && role.agents.some((id) => eligibleAgents.includes(id)));
      setRoles(allowed); setRoleId(allowed[0]?.id ?? "");
      setAgent(allowed[0]?.agents.find((id) => eligibleAgents.includes(id)) ?? "");
    }).catch((reason) => { if (active) setError(contextDisplayText((reason as Error).message)); });
    getClientContextOptions(issue.project_id).then((value) => { if (active) setConsentOptions(value); })
      .catch((reason) => { if (active) setConsentError((reason as Error).message); });
    return () => { active = false; };
  }, [issue.id, issue.project_id, issue.revision, eligibility]);

  const selectedRole = roles.find((role) => role.id === roleId);
  const agents = selectedRole?.agents.filter((id) => eligibleAgents.includes(id)) ?? [];
  const context = useContextPreview(selectedRole && agents.includes(agent) ? {
    kind: "issue", project: issue.project_id, issue_id: issue.id, expected_revision: issue.revision,
    agent, role_id: roleId, client_context_categories: categories,
  } : null);

  return <div className="work-issue-lineage" aria-label={`Despacho de ${issue.title}`}>
    <p className="work-issue-note">Preview sobre revisión {issue.revision} · scope r{issue.scope_revision}. La asignación autorizada no se cambia al seleccionar un perfil.</p>
    <div className="organization-form-grid">
      <label>Perfil Codex
        <select aria-label={`Perfil Codex de ${issue.title}`} value={roleId} disabled={busy || roles.length === 0} onChange={(event) => {
          setRoleId(event.target.value); setCategories([]);
          setAgent(roles.find((role) => role.id === event.target.value)?.agents.find((id) => eligibleAgents.includes(id)) ?? "");
        }}><option value="" disabled>Seleccionar perfil de implementación</option>{roles.map((role) => <option key={role.id} value={role.id}>{role.display_name}</option>)}</select>
      </label>
      <label>Agente autorizado
        <select aria-label={`Agente autorizado de ${issue.title}`} value={agent} disabled={busy || Boolean(issue.assigned_role_id) || agents.length === 0}
          onChange={(event) => { setAgent(event.target.value); setCategories([]); }}>
          <option value="" disabled>Seleccionar agente</option>{agents.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </label>
    </div>
    {selectedRole && <p className="work-issue-note">{contextDisplayText(selectedRole.responsibility)}</p>}
    {error && <p role="alert">{error}</p>}
    {!error && roles.length === 0 && <p className="work-issue-note">Sin perfil compatible disponible; no se puede despachar mientras se resuelve la política.</p>}
    <ClientContextConsent options={consentOptions} categories={categories} onChange={setCategories} disabled={busy} error={consentError} />
    {context.error && <p role="alert">{context.error}</p>}
    {context.preview && <ContextPreview preview={context.preview} expectedIssueId={issue.id} />}
    {!context.preview && <p className="work-issue-note">Generá y revisá el preview antes de despachar. Actualizar el issue o cambiar perfil, agente o consentimiento requiere un preview nuevo.</p>}
    <div className="actions work-issue-actions">
      <button type="button" className="ibtn" disabled={busy || context.pending || !selectedRole || !agents.includes(agent)} onClick={() => void context.requestPreview()}>
        {context.pending ? "Previsualizando…" : "Previsualizar contexto del issue"}
      </button>
      <button type="button" className="ibtn primary" disabled={busy || context.pending || !context.preview?.allowed} onClick={() => {
        if (busy || !context.preview?.allowed) return;
        const fingerprint = context.preview.fingerprint;
        context.clearPreview();
        void perform(() => dispatchWorkIssue(issue.id, issue.revision, agent, {
          role_id: roleId, preview_fingerprint: fingerprint, client_context_categories: categories,
        }));
      }}>Despachar tarea aprobada</button>
    </div>
  </div>;
}

export interface WorkflowFocus { issueId: string; workflowId: string; projectId: string }
export function IssuesView({ workflowFocus, onOpenTask }: { workflowFocus?: WorkflowFocus | null; onOpenTask?: (id: string) => void } = {}) {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [externalError, setExternalError] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const [issues, setIssues] = useState<WorkIssue[]>([]);
  const [dispatchOptions, setDispatchOptions] = useState<DispatchOptions | null>(null);
  const [organization, setOrganization] = useState<OrganizationSnapshot | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dispatchEpoch, setDispatchEpoch] = useState(0);
  const [budgetEpoch, setBudgetEpoch] = useState(0);
  const [lineageEpoch, setLineageEpoch] = useState(0);
  const [workflows, setWorkflows] = useState<GovernedWorkflow[] | null>(null);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [workflowExpanded, setWorkflowExpanded] = useState<Record<string, boolean>>({});
  const refreshSequence = useRef(0);
  const [lineage, setLineage] = useState<Record<string, IssueLineage>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [confirmed, setConfirmed] = useState<Record<string, string[]>>({});
  const [acknowledgeGap, setAcknowledgeGap] = useState<Record<string, boolean>>({});
  const [projectId, setProjectId] = useState("");
  const [agent, setAgent] = useState("");
  const [objectiveId, setObjectiveId] = useState("");
  const [title, setTitle] = useState("");
  const [outcome, setOutcome] = useState("");
  const [criteria, setCriteria] = useState("");
  const [allowedPaths, setAllowedPaths] = useState("");
  const [excludedPaths, setExcludedPaths] = useState("");
  const [categories, setCategories] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [domains, setDomains] = useState("");
  const [plan, setPlan] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [criticality, setCriticality] = useState<"low" | "medium" | "high">("low");
  const [migration, setMigration] = useState(false);
  const [securityImpact, setSecurityImpact] = useState(false);
  const [commitments, setCommitments] = useState("");

  const intakeConfirmed = useCallback((issue: WorkIssue) => {
    refreshSequence.current++;
    setIssues((current) => [issue, ...current.filter((entry) => entry.id !== issue.id)]);
    setTitle(""); setOutcome(""); setCriteria(""); setAllowedPaths(""); setExcludedPaths(""); setCategories(""); setExclusions(""); setDomains(""); setPlan(""); setNextAction(""); setCommitments("");
  }, []);
  const intake = useIssueIntake(intakeConfirmed);
  const captureIntake = intake.capture, observeIntake = intake.observe;
  const refresh = useCallback(async () => {
    const generation = ++refreshSequence.current;
    const intakeBinding = captureIntake();
    setLineage({}); setConfirmed({}); setAcknowledgeGap({});
    setBudgetEpoch((value) => value + 1);
    setWorkflows(null); setWorkflowError(null);
    const [localResult, externalResult, optionsResult, organizationResult, workflowResult] = await Promise.allSettled([
      getWorkIssues(), getInbox(), fetchDispatchOptions(), getOrganization(), getWorkflows(),
    ]);
    if (generation !== refreshSequence.current) return;
    if (localResult.status === "fulfilled") { setIssues(localResult.value.issues); setLineageEpoch((value) => value + 1); setLocalError(null); observeIntake(localResult.value, intakeBinding); }
    else setLocalError("La lectura de issues no está disponible; no se pudo confirmar el estado actual.");
    if (externalResult.status === "fulfilled") { setInbox(externalResult.value); setExternalError(null); }
    else setExternalError("La lectura del proveedor no está disponible.");
    if (optionsResult.status === "fulfilled") setDispatchOptions(optionsResult.value);
    if (organizationResult.status === "fulfilled") setOrganization(organizationResult.value);
    if (workflowResult.status === "fulfilled") { setWorkflows(workflowResult.value.workflows); setWorkflowError(null); }
    else setWorkflowError("La lectura de autoridad no está disponible");
  }, [captureIntake, observeIntake]);

  useEffect(() => { void refresh(); return () => { refreshSequence.current++; }; }, [refresh]);
  useEffect(() => {
    let active = true;
    const generation = refreshSequence.current;
    const open = issues.filter((issue) => expanded[issue.id]);
    setLineage({});
    for (const issue of open) {
      getWorkIssue(issue.id).then((detail) => {
        if (!active || generation !== refreshSequence.current) return;
        if (detail.issue.id !== issue.id || detail.issue.project_id !== issue.project_id
          || detail.issue.revision !== issue.revision || detail.issue.scope_revision !== issue.scope_revision) {
          setLocalError("El linaje no coincide con la revisión visible; actualizá antes de revisarlo."); return;
        }
        setLineage((value) => ({ ...value, [issue.id]: detail }));
      }).catch(() => { if (active && generation === refreshSequence.current) setLocalError("El linaje no está disponible; actualizá para volver a consultar la evidencia."); });
    }
    return () => { active = false; };
  }, [issues, expanded, lineageEpoch]);
  useEffect(() => {
    if (!workflowFocus || !issues.some((issue) => issue.id === workflowFocus.issueId && issue.project_id === workflowFocus.projectId)) return;
    setWorkflowExpanded((current) => ({ ...current, [workflowFocus.issueId]: true }));
    document.getElementById(`work-issue-${workflowFocus.issueId}`)?.scrollIntoView?.({ block: "start" });
  }, [workflowFocus, issues]);

  const projectOptions = useMemo(() => (dispatchOptions?.projects ?? []).filter((project) => project.has_local_checkout), [dispatchOptions]);
  const selectedProject = projectOptions.find((project) => project.project === projectId) ?? projectOptions[0];
  const agentOptions = selectedProject?.agents.filter((entry) => entry.allowed_modes.includes("workspace-write")) ?? [];
  const objectives = organization?.objectives.filter((objective) => objective.project_ids.includes(selectedProject?.project ?? "")) ?? [];
  const repoIds = useMemo(() => (inbox ? inbox.repos.map((entry) => entry.id) : []), [inbox]);
  const failed = inbox ? inbox.repos.filter((entry) => !entry.ok) : [];
  const allFailed = inbox != null && inbox.repos.length > 0 && failed.length === inbox.repos.length;
  const externalItems = inbox ? (repo ? inbox.items.filter((item) => item.projectId === repo) : inbox.items) : [];

  async function perform(issueId: string, operation: () => Promise<unknown>) {
    setBusy(issueId);
    setLocalError(null);
    try {
      await operation();
      // A successful mutation invalidates candidate/evidence presentation and
      // criterion confirmations, even when a subsequent read fails.
      setLineage((value) => { const next = { ...value }; delete next[issueId]; return next; });
      setConfirmed((value) => ({ ...value, [issueId]: [] }));
      setAcknowledgeGap((value) => ({ ...value, [issueId]: false }));
      await refresh();
    }
    catch { setLocalError("La operación fue rechazada o no se pudo confirmar. Actualizá y revisá el estado antes de intentarla otra vez."); }
    finally { setBusy(null); }
  }

  async function showLineage(issue: WorkIssue) {
    const next = !expanded[issue.id];
    setExpanded((value) => ({ ...value, [issue.id]: next }));
    setConfirmed((value) => ({ ...value, [issue.id]: [] }));
    setAcknowledgeGap((value) => ({ ...value, [issue.id]: false }));
  }

  async function submitIssue(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProject) { setLocalError("Seleccioná un repositorio local."); return; }
    const acceptanceCriteria = lines(criteria);
    const allowed = lines(allowedPaths);
    const changeCategories = words(categories);
    setLocalError(null);
    const confirmed = await intake.submit({
        project_id: selectedProject.project, objective_id: objectiveId || null, title, expected_outcome: outcome,
        acceptance_criteria: acceptanceCriteria,
        authorized_scope: {
          expected_outcome: outcome.trim(), acceptance_criteria: acceptanceCriteria,
          allowed_path_patterns: allowed, excluded_path_patterns: lines(excludedPaths),
          allowed_change_categories: changeCategories, explicit_exclusions: lines(exclusions),
        },
        classification_inputs: { affected_domains: words(domains), requires_migration: migration, security_impact: securityImpact },
        plan: lines(plan), criticality, assigned_role_id: agent || null, next_action: nextAction || null,
        related_commitment_ids: words(commitments),
      });
    if (confirmed) await refresh();
  }

  return (
    <div className="issues-view">
      <div className="section-head"><h2>Issues</h2><span className="meta">{issues.length} locales · {inbox ? `${externalItems.length} externos` : "cargando…"}</span></div>

      {localError && <div className="banner banner--warn view-note" role="alert">No pude completar la operación local ({localError}).</div>}
      {workflowError && <div className="banner banner--warn view-note" role="alert">No pude consultar la autoridad de workflows ({workflowError}); las acciones manuales quedan desactivadas.</div>}
      {workflowFocus && issues.length > 0 && !issues.some((issue) => issue.id === workflowFocus.issueId && issue.project_id === workflowFocus.projectId) && <p role="alert">El issue del workflow no está disponible en este proyecto; no se abre otra autoridad.</p>}

      <section className="panel work-issues-panel">
        <div className="work-issues-heading"><div><span className="organization-kicker">FUENTE LOCAL DE VERDAD</span><h3>Trabajo aprobado</h3><p>El alcance, la autorización y la evidencia permanecen en este Control Plane.</p></div><button type="button" className="ghost-btn" disabled={busy !== null || intake.sending} onClick={() => { setDispatchEpoch((value) => value + 1); void refresh(); }}>Actualizar</button></div>

        {intake.confirmedId && <p className="work-issue-note" role="status">Pedido confirmado: {intake.confirmedId}.</p>}
        {intake.pending && <section className="banner banner--warn view-note" aria-label="Pedido local pendiente">
          <p role="status">{intake.message ?? (intake.sending ? "Confirmando el mismo pedido…" : "Hay un pedido pendiente de confirmación. No se crea otro automáticamente.")}</p>
          <p className="work-issue-note">Solo se guarda su UUID en esta pestaña. El contenido permanece en memoria; al recargar se consulta el estado sin reenviarlo.</p>
          <div className="actions">
            {intake.pending.payload && <button type="button" className="ibtn" disabled={intake.sending || intake.checking} onClick={() => { void intake.retry().then((confirmed) => { if (confirmed) return refresh(); }); }}>Reintentar mismo pedido</button>}
            <button type="button" className="ibtn" disabled={intake.sending || intake.checking} onClick={() => void intake.check()}>Comprobar pedido pendiente</button>
          </div>
          <label><input type="checkbox" checked={intake.cancelAcknowledged} disabled={intake.sending} onChange={(event) => intake.setCancelAcknowledged(event.target.checked)} />Entiendo que el pedido podría existir; cancelar este intento no lo elimina.</label>
          <button type="button" className="ibtn" disabled={intake.sending || !intake.cancelAcknowledged} onClick={intake.cancel}>Cancelar intento pendiente</button>
        </section>}

        <details className="work-issue-create">
          <summary>Crear issue local</summary>
          <form onSubmit={(event) => void submitIssue(event)}>
            <fieldset className="organization-form-grid" aria-label="Datos del pedido local" disabled={intake.pending !== null || intake.sending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <label>Repositorio
                <select aria-label="Repositorio local" value={selectedProject?.project ?? ""} onChange={(event) => { setProjectId(event.target.value); setAgent(""); setObjectiveId(""); }} required>
                  <option value="" disabled>Seleccionar checkout local</option>
                  {projectOptions.map((project) => <option key={project.project} value={project.project}>{project.project}</option>)}
                </select>
              </label>
              <label>Agente habilitado (asignación)
                <select aria-label="Agente habilitado" value={agent} onChange={(event) => setAgent(event.target.value)}>
                  <option value="">{agentOptions.length ? "Asignar al autorizar" : "Sin capacidad workspace-write"}</option>{agentOptions.map((entry) => <option key={entry.agent} value={entry.agent}>{entry.agent}</option>)}
                </select>
              </label>
              {objectives.length > 0 && <label>Objetivo SURTEC (opcional)
                <select aria-label="Objetivo SURTEC" value={objectiveId} onChange={(event) => setObjectiveId(event.target.value)}>
                  <option value="">Sin objetivo asociado</option>{objectives.map((objective) => <option key={objective.id} value={objective.id}>{objective.title}</option>)}
                </select>
              </label>}
              <label>Criticidad
                <select value={criticality} onChange={(event) => setCriticality(event.target.value as typeof criticality)}><option value="low">Baja</option><option value="medium">Media</option><option value="high">Alta</option></select>
              </label>
              <label className="organization-form-wide">Título
                <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} required />
              </label>
              <label className="organization-form-wide">Resultado esperado
                <textarea value={outcome} onChange={(event) => setOutcome(event.target.value)} maxLength={4000} required />
              </label>
              <label className="organization-form-wide">Criterios de aceptación (uno por línea)
                <textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="El flujo persiste el cambio…" required />
              </label>
              <label>Paths permitidos (glob, uno por línea)
                <textarea value={allowedPaths} onChange={(event) => setAllowedPaths(event.target.value)} placeholder="src/**" required />
              </label>
              <label>Paths excluidos (opcional)
                <textarea value={excludedPaths} onChange={(event) => setExcludedPaths(event.target.value)} placeholder="secrets/**" />
              </label>
              <label>Categorías de cambio (coma separadas)
                <input value={categories} onChange={(event) => setCategories(event.target.value)} placeholder="ui, tests" required />
              </label>
              <label>Dominios afectados (coma separados)
                <input value={domains} onChange={(event) => setDomains(event.target.value)} placeholder="dashboard" />
              </label>
              <label className="organization-form-wide">Exclusiones explícitas (uno por línea)
                <textarea value={exclusions} onChange={(event) => setExclusions(event.target.value)} placeholder="No modificar contratos públicos" />
              </label>
              <label>Plan (uno por línea; requerido para escala sustancial)
                <textarea value={plan} onChange={(event) => setPlan(event.target.value)} />
              </label>
              <label>Próxima acción
                <input value={nextAction} onChange={(event) => setNextAction(event.target.value)} placeholder="Implementar el cambio y validar…" />
              </label>
              <label className="work-issue-toggle"><input type="checkbox" checked={migration} onChange={(event) => setMigration(event.target.checked)} /> Requiere migración</label>
              <label className="work-issue-toggle"><input type="checkbox" checked={securityImpact} onChange={(event) => setSecurityImpact(event.target.checked)} /> Impacto de seguridad</label>
              <label className="organization-form-wide">Compromisos relacionados (IDs, opcional)
                <input value={commitments} onChange={(event) => setCommitments(event.target.value)} placeholder="COM-…" />
              </label>
            </fieldset>
            <p className="work-issue-note">La escala se clasifica de forma determinística. Crear no autoriza ejecución: primero revisás y autorizás exactamente este scope.</p>
            <div className="organization-form-actions"><button className="ibtn primary" type="submit" disabled={intake.pending !== null || intake.sending}>{intake.sending ? "Creando…" : "Crear propuesta local"}</button></div>
          </form>
        </details>

        {issues.length === 0 ? <div className="empty"><p>{localError ? "Issues locales no disponibles" : "Todavía no hay propuestas locales"}</p></div> : (
          <div className="work-issue-list">
            {issues.map((issue) => {
              const owner = workflows?.find((workflow) => workflow.issue_id === issue.id && !["completed", "cancelled"].includes(workflow.status));
              const manualAllowed = workflows !== null && !workflowError && !owner;
              const recordedDetail = lineage[issue.id];
              const detail = recordedDetail?.issue.revision === issue.revision && recordedDetail.issue.scope_revision === issue.scope_revision
                ? recordedDetail : undefined;
              const currentCandidate = detail?.candidates.find((candidate) => candidate.invalidated_at === null && candidate.scope_revision === issue.scope_revision);
              const checks = confirmed[issue.id] ?? [];
              const candidateGaps = detail?.evidence_gaps ?? [];
              const canAccept = Boolean(currentCandidate && issue.acceptance_criteria.every((criterion) => checks.includes(criterion))
                && (candidateGaps.every((gap) => !gap.startsWith("Passing verification")) || acknowledgeGap[issue.id]));
              const blockers = issue.blocked_by_issue_ids.map((id) => ({ id, issue: issues.find((entry) => entry.id === id) }));
              return <article className="work-issue-card" key={issue.id} id={`work-issue-${issue.id}`}>
                <div className="work-issue-card__top"><span className={`work-issue-status work-issue-status--${issue.status.replace(/[^a-z-]/g, "")}`}>{operatingLabels[issue.status] ?? issue.status}</span>{operatingLabels[issue.status] && <span className="badge-mini">{issue.status}</span>}<span className="badge-mini">{issue.work_scale}</span><span className="badge-mini">scope r{issue.scope_revision}</span><span className="work-issue-project">{issue.project_id}</span></div>
                <h3>{issue.title}</h3><p>{issue.expected_outcome}</p>
                <div className="work-issue-meta"><span>{issue.acceptance_criteria.length} criterios</span><span>{issue.task_ids.length} tareas</span><span>{issue.classification_rationale.join(" · ")}</span></div>
                <section aria-label={`Resultado y linaje de ${issue.title}`}>
                  <p><b>Referencias canónicas:</b> {issue.id} · Proyecto: {issue.project_id} · Objetivo: {issue.objective_id ?? "sin objetivo asociado"} · Issue padre: {issue.parent_issue_id ?? "sin padre registrado"}</p>
                  <p><b>Asignación registrada:</b> {issue.assigned_role_id ?? "sin asignación"} · Compromisos: {issue.related_commitment_ids.join(", ") || "ninguno registrado"}</p>
                  <p className="work-issue-note">Observación del issue: <time dateTime={issue.updated_at}>{issue.updated_at}</time> · revisión {issue.revision}. Actualizar la pantalla no renueva esta evidencia.</p>
                  <p className="work-issue-note">La finalización de una tarea o workflow no acepta el issue ni prueba entrega al cliente. «Hecho» representa únicamente el estado aceptado del issue.</p>
                </section>
                <IssueScope issue={issue} />
                {(issue.status === "needs-decision" || issue.status === "blocked") && <section className="work-issue-proposal" aria-label={`Decisión actual de ${issue.title}`}>
                  <h4>Motivo y próxima acción</h4>
                  {issue.scope_change_proposal ? <p><b>Disparador registrado: cambio de scope.</b> Propuesta {issue.scope_change_proposal.id} · detectada {issue.scope_change_proposal.discovered_at} · tarea {issue.scope_change_proposal.evidence_task_id ?? "no registrada"}.</p>
                    : owner?.blocked_reason ? <p><b>Motivo registrado por el workflow:</b> {contextDisplayText(owner.blocked_reason)}</p>
                      : <p><b>Brecha de motivo:</b> la fuente no registra un disparador clasificable. No se infiere de la próxima acción, del resultado de una tarea ni de un presupuesto configurado.</p>}
                  {blockers.length > 0 && <p><b>Dependencias registradas:</b> {blockers.map((entry) => `${entry.id}: ${entry.issue ? entry.issue.status : "estado no disponible"}`).join(" · ")}. No sustituyen el motivo de la decisión.</p>}
                  <p><b>Próxima acción registrada:</b> {issue.next_action ?? owner?.next_action ?? "Revisar la evidencia y la autoridad vigente antes de actuar."}</p>
                  {owner && <p className="work-issue-note">Abrí el workflow {owner.id} para consultar su decisión exacta; esta explicación no aprueba, reintenta ni ejecuta.</p>}
                </section>}
                {owner && <p className="work-issue-note">Workflow activo {owner.id}. Usá su decisión o stop; despacho, reintento y aceptación manual no reemplazan su autoridad.</p>}
                {manualAllowed && issue.status === "needs-decision" && issue.scope_change_proposal && <div className="banner banner--warn work-issue-proposal"><b>Scope ampliado requiere tu decisión.</b><div>{issue.scope_change_proposal.discovered_paths.join(", ")}</div><div className="actions"><button className="ibtn primary" disabled={busy === issue.id} onClick={() => void perform(issue.id, () => approveWorkIssueScope(issue))}>Autorizar nueva revisión de scope</button><button className="ibtn" disabled={busy === issue.id} onClick={() => void perform(issue.id, () => rejectWorkIssueScope(issue))}>Rechazar y cancelar issue</button></div></div>}
                {manualAllowed && issue.status === "needs-decision" && !issue.scope_change_proposal && <div className="banner banner--warn work-issue-proposal"><b>La evidencia no habilita revisión todavía.</b><div>{issue.next_action ?? "Revisá la brecha antes de autorizar otro intento."}</div><button className="ibtn primary" disabled={busy === issue.id} onClick={() => void perform(issue.id, () => resolveWorkIssueDecision(issue))}>Autorizar reintento con scope sin cambios</button></div>}
                <div className="actions work-issue-actions">
                  {manualAllowed && issue.status === "proposed" && <button className="ibtn primary" disabled={busy === issue.id} onClick={() => void perform(issue.id, () => authorizeWorkIssue(issue.id, issue.revision))}>Autorizar scope exacto</button>}
                  {manualAllowed && issue.status === "blocked" && <button className="ibtn primary" disabled={busy === issue.id} onClick={() => void perform(issue.id, () => resumeWorkIssue(issue))}>Revisé el bloqueo · autorizar reanudación</button>}
                  {issue.status === "ready-for-review" && <button className="ibtn primary" disabled={busy === issue.id} onClick={() => void showLineage(issue)}>{expanded[issue.id] ? "Ocultar revisión" : "Revisar candidato"}</button>}
                  <button className="ibtn" disabled={busy === issue.id} onClick={() => void showLineage(issue)}>{expanded[issue.id] ? "Ocultar linaje" : "Ver linaje y evidencia"}</button>
                  <button type="button" className="ibtn" aria-expanded={workflowExpanded[issue.id] ?? false} disabled={busy === issue.id} onClick={() => setWorkflowExpanded((current) => ({ ...current, [issue.id]: !current[issue.id] }))}>{workflowExpanded[issue.id] ? "Ocultar workflow" : "Ver workflow"}</button>
                </div>
                {workflowExpanded[issue.id] && <WorkflowPanel issue={issue} refreshKey={dispatchEpoch} initialWorkflowId={workflowFocus?.issueId === issue.id ? workflowFocus.workflowId : undefined} onChanged={refresh} onOpenTask={onOpenTask} />}
                {manualAllowed && issue.status === "authorized" && <IssueDispatch key={`${issue.id}:${issue.project_id}:${issue.revision}:${dispatchEpoch}`} issue={issue} options={dispatchOptions}
                  busy={busy !== null} perform={(operation) => perform(issue.id, operation)} />}
                {expanded[issue.id] && <div className="work-issue-lineage">
                  <BudgetSummary title="Presupuesto del proyecto" projectId={issue.project_id} refreshKey={`${issue.id}:${issue.revision}:${budgetEpoch}`} />
                  <p className="work-issue-note">Esta consulta muestra el presupuesto del proyecto, no el presupuesto exacto del issue, su objetivo, rol o ejecución. No sustituye el preview ni la autorización vigente.</p>
                  {!detail ? <p className="empty-mini">{localError ? "Ejecución y evidencia no confirmadas para esta revisión." : "Cargando ejecución y evidencia…"}</p> : <>
                    <section aria-label={`Intentos y sesiones de ${issue.title}`}>
                      <h4>Workflow, intentos y sesiones</h4>
                      <p>Workflow propietario: {owner?.id ?? "ninguno activo en la lectura disponible"}. Los handoffs y gates se consultan en «Ver workflow».</p>
                      {detail.tasks.length === 0 ? <p>Sin tareas vinculadas en esta lectura.</p> : detail.tasks.map((entry) => <div key={entry.task.envelope.id}>
                        <b>Tarea {entry.task.envelope.id}</b> · {entry.task.lifecycle} · resultado {entry.task.outcome ?? "sin resultado registrado"}
                        {onOpenTask && <button type="button" className="ibtn" onClick={() => onOpenTask(entry.task.envelope.id)}>Ver tarea {entry.task.envelope.id}</button>}
                        <p>Intentos: {entry.executions.map((execution) => `#${execution.attempt} · run ${execution.run_id}`).join(" · ") || "sin ejecución registrada"}</p>
                      </div>)}
                      <p><b>Sesiones:</b> {detail.sessions.map((session) => session.id).join(", ") || "sin sesión vinculada"}. Las notas privadas de sesión no se copian a este resumen.</p>
                      <p className="work-issue-note">El detalle actual expone referencias de ejecución y evidencia, no un log completo de auditoría del issue. No se fabrica auditoría a partir de resultados o tiempos de carga.</p>
                    </section>
                    <section aria-label={`Candidatos y testing de ${issue.title}`}>
                    <h4>Candidato, testing y revisión</h4>
                    <p className="work-issue-note">Los requisitos efectivos de testing/review están en el grant del workflow o la admisión de la tarea. Tests declarados por un agente, verificación de infraestructura y aceptación humana son hechos distintos.</p>
                    <div><b>Brechas de evidencia:</b> {detail.evidence_gaps.length ? detail.evidence_gaps.join(" ") : "sin brechas conocidas"}</div>
                    {detail.candidates.map((candidate) => <div className="work-issue-candidate" key={candidate.id}>
                      <b>{candidate.invalidated_at ? "Candidato invalidado" : candidate.scope_revision !== issue.scope_revision ? "Candidato de otro scope" : candidate.id !== currentCandidate?.id ? "Candidato no seleccionado en esta lectura" : "Candidato registrado para el scope actual"} · {candidate.candidate_revision.slice(0, 12)}</b>
                      <span>{candidate.id} · tarea {candidate.task_id} · run {candidate.execution_id} · scope r{candidate.scope_revision} · observado {candidate.created_at}</span>
                      <span>Base {candidate.base_revision} · candidato {candidate.candidate_revision} · fingerprint {candidate.diff_fingerprint} · {candidate.changed_paths.join(", ")}</span>
                      <small>Vigencia Git no comprobada por esta lectura; el endpoint protegido revalida antes de aceptar.</small>
                    </div>)}
                    {manualAllowed && issue.status === "ready-for-review" && currentCandidate && <div className="work-issue-review">
                      <b>Confirmá cada criterio sobre este commit</b>
                      <div className="organization-checkboxes">{issue.acceptance_criteria.map((criterion) => <label key={criterion}><input type="checkbox" checked={checks.includes(criterion)} onChange={(event) => setConfirmed((value) => ({ ...value, [issue.id]: event.target.checked ? [...checks, criterion] : checks.filter((item) => item !== criterion) }))} />{criterion}</label>)}</div>
                      {candidateGaps.some((gap) => gap.startsWith("Passing verification")) && <label className="work-issue-toggle"><input type="checkbox" checked={acknowledgeGap[issue.id] ?? false} onChange={(event) => setAcknowledgeGap((value) => ({ ...value, [issue.id]: event.target.checked }))} />Entiendo y acepto explícitamente la brecha de verificación automatizada</label>}
                      <button className="ibtn primary" disabled={!canAccept || busy === issue.id} onClick={() => void perform(issue.id, () => acceptWorkIssueCandidate(issue, currentCandidate, checks, acknowledgeGap[issue.id] ?? false))}>Aceptar este candidato local</button>
                    </div>}
                    <div className="work-issue-evidence">{detail.evidence.length === 0 && <p>Sin referencias de evidencia registradas; no equivale a verificación aprobada.</p>}{detail.evidence.map((entry) => <div key={entry.id}><span className={`evidence-status evidence-status--${entry.status}`}>{entry.status}</span><b>{entry.label}</b><small>{entry.kind} · {entry.id} · {entry.created_at}</small><small>{entry.reference}</small><small>Scope r{entry.scope_revision} · tarea {entry.task_id ?? "no vinculada"} · run {entry.execution_id ?? "no vinculado"} · candidato {entry.candidate_id ?? "no vinculado"} · commit {entry.candidate_revision ?? "no vinculado"} · fingerprint {entry.diff_fingerprint ?? "no vinculado"}</small></div>)}</div>
                    </section>
                    <DeliveryReadinessPanel key={`delivery:${issue.id}:${issue.revision}:${issue.scope_revision}`} projectId={issue.project_id}
                      lineage={detail} disabled={busy !== null || !manualAllowed} onChanged={async () => {
                        setDispatchEpoch((value) => value + 1);
                        await refresh();
                      }} />
                  </>}
                </div>}
              </article>;
            })}
          </div>
        )}
      </section>

      <section className="work-provider-issues">
        <div className="section-head"><h2>Issues externos</h2><span className="meta">Referencias GitHub · solo lectura</span></div>
        <div className="field" style={{ maxWidth: 280, marginBottom: 16 }}>
          <label htmlFor="inbox-repo">Repositorio externo</label>
          <select id="inbox-repo" aria-label="Repositorio externo" value={repo} onChange={(event) => setRepo(event.target.value)}>
            <option value="">Todos los repos</option>{repoIds.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </div>
        {externalError && <div className="banner banner--warn view-note">No pude leer los issues externos ({externalError}).</div>}
        {allFailed && <div className="banner banner--danger view-note">GitHub no disponible (¿gh instalado y autenticado?).</div>}
        {!allFailed && failed.length > 0 && <div className="banner banner--warn view-note">No se pudo leer: {failed.map((entry) => entry.id).join(", ")}.</div>}
        {!inbox && !externalError ? <p className="empty-mini">cargando issues externos…</p> : externalItems.length === 0 ? <div className="empty"><p>Sin issues externos abiertos</p></div> : (
          <div className="panel" style={{ padding: "6px 18px" }}>
            {externalItems.map((item) => <div key={`${item.slug}#${item.number}`} className="issue-row">
              <span className="issue-repo">{item.projectId}</span><span className="issue-num">#{item.number}</span>
              <a className="issue-title" href={item.url} target="_blank" rel="noreferrer">{item.title} <ExternalLink /></a>
              <span className="issue-labels">{item.labels.map((label) => <span key={label} className="badge-mini">{label}</span>)}</span>
              {item.author && <span className="issue-author">@{item.author}</span>}<span className="issue-when">{item.updatedAt ? relativeTime(item.updatedAt) : ""}</span>
            </div>)}
          </div>
        )}
      </section>
    </div>
  );
}
