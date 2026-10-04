import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { Inbox } from "../../../../lib/state/types";
import type { IssueLineage, WorkIssue } from "../../../../lib/issues/types";
import type { OrganizationSnapshot } from "../../../../lib/organization";
import type { ClientContextCategory, ClientContextOptions } from "../../../../lib/client-portfolio";
import type { GovernedWorkflow } from "../../../../lib/workflows/types";
import {
  acceptWorkIssueCandidate, approveWorkIssueScope, authorizeWorkIssue, createWorkIssue,
  dispatchWorkIssue, fetchDispatchOptions, getInbox, getOrganization, getWorkIssue, getWorkIssues, rejectWorkIssueScope, resumeWorkIssue,
  resolveWorkIssueDecision, getContextRoles, getClientContextOptions, getWorkflows, type ContextRole, type DispatchOptions,
} from "../api";
import { relativeTime } from "../relative-time";
import { ClientContextConsent, ContextPreview, contextDisplayText, useContextPreview } from "../components/ContextPreview";
import { WorkflowPanel } from "../components/WorkflowPanel";

function lines(value: string): string[] { return value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean); }
function words(value: string): string[] { return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean); }

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
    {context.preview && <ContextPreview preview={context.preview} />}
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

  const refresh = useCallback(async () => {
    const generation = ++refreshSequence.current;
    setWorkflows(null); setWorkflowError(null);
    const [localResult, externalResult, optionsResult, organizationResult, workflowResult] = await Promise.allSettled([
      getWorkIssues(), getInbox(), fetchDispatchOptions(), getOrganization(), getWorkflows(),
    ]);
    if (generation !== refreshSequence.current) return;
    if (localResult.status === "fulfilled") { setIssues(localResult.value.issues); setLocalError(null); }
    else setLocalError((localResult.reason as Error).message);
    if (externalResult.status === "fulfilled") { setInbox(externalResult.value); setExternalError(null); }
    else setExternalError((externalResult.reason as Error).message);
    if (optionsResult.status === "fulfilled") setDispatchOptions(optionsResult.value);
    if (organizationResult.status === "fulfilled") setOrganization(organizationResult.value);
    if (workflowResult.status === "fulfilled") { setWorkflows(workflowResult.value.workflows); setWorkflowError(null); }
    else setWorkflowError(contextDisplayText((workflowResult.reason as Error).message));
  }, []);

  useEffect(() => { void refresh(); return () => { refreshSequence.current++; }; }, [refresh]);
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
      if (expanded[issueId]) {
        const detail = await getWorkIssue(issueId);
        setLineage((value) => ({ ...value, [issueId]: detail }));
      }
    }
    catch (error) { setLocalError((error as Error).message); }
    finally { setBusy(null); }
  }

  async function showLineage(issue: WorkIssue) {
    const next = !expanded[issue.id];
    setExpanded((value) => ({ ...value, [issue.id]: next }));
    if (next) {
      setLineage((value) => { const fresh = { ...value }; delete fresh[issue.id]; return fresh; });
      try { const detail = await getWorkIssue(issue.id); setLineage((value) => ({ ...value, [issue.id]: detail })); }
      catch (error) { setLocalError((error as Error).message); }
    }
  }

  async function submitIssue(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProject) { setLocalError("Seleccioná un repositorio local."); return; }
    const acceptanceCriteria = lines(criteria);
    const allowed = lines(allowedPaths);
    const changeCategories = words(categories);
    setBusy("create");
    setLocalError(null);
    try {
      await createWorkIssue({
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
      setTitle(""); setOutcome(""); setCriteria(""); setAllowedPaths(""); setExcludedPaths(""); setCategories(""); setExclusions(""); setDomains(""); setPlan(""); setNextAction(""); setCommitments("");
      await refresh();
    } catch (error) { setLocalError((error as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <div className="issues-view">
      <div className="section-head"><h2>Issues</h2><span className="meta">{issues.length} locales · {inbox ? `${externalItems.length} externos` : "cargando…"}</span></div>

      {localError && <div className="banner banner--warn view-note" role="alert">No pude completar la operación local ({localError}).</div>}
      {workflowError && <div className="banner banner--warn view-note" role="alert">No pude consultar la autoridad de workflows ({workflowError}); las acciones manuales quedan desactivadas.</div>}
      {workflowFocus && issues.length > 0 && !issues.some((issue) => issue.id === workflowFocus.issueId && issue.project_id === workflowFocus.projectId) && <p role="alert">El issue del workflow no está disponible en este proyecto; no se abre otra autoridad.</p>}

      <section className="panel work-issues-panel">
        <div className="work-issues-heading"><div><span className="organization-kicker">FUENTE LOCAL DE VERDAD</span><h3>Trabajo aprobado</h3><p>El alcance, la autorización y la evidencia permanecen en este Control Plane.</p></div><button type="button" className="ghost-btn" disabled={busy !== null} onClick={() => { setDispatchEpoch((value) => value + 1); void refresh(); }}>Actualizar</button></div>

        <details className="work-issue-create">
          <summary>Crear issue local</summary>
          <form onSubmit={(event) => void submitIssue(event)}>
            <div className="organization-form-grid">
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
            </div>
            <p className="work-issue-note">La escala se clasifica de forma determinística. Crear no autoriza ejecución: primero revisás y autorizás exactamente este scope.</p>
            <div className="organization-form-actions"><button className="ibtn primary" type="submit" disabled={busy === "create"}>{busy === "create" ? "Creando…" : "Crear propuesta local"}</button></div>
          </form>
        </details>

        {issues.length === 0 ? <div className="empty"><p>{localError ? "Issues locales no disponibles" : "Todavía no hay propuestas locales"}</p></div> : (
          <div className="work-issue-list">
            {issues.map((issue) => {
              const owner = workflows?.find((workflow) => workflow.issue_id === issue.id && !["completed", "cancelled"].includes(workflow.status));
              const manualAllowed = workflows !== null && !workflowError && !owner;
              const detail = lineage[issue.id];
              const currentCandidate = detail?.candidates.find((candidate) => candidate.invalidated_at === null && candidate.scope_revision === issue.scope_revision);
              const checks = confirmed[issue.id] ?? [];
              const candidateGaps = detail?.evidence_gaps ?? [];
              const canAccept = Boolean(currentCandidate && issue.acceptance_criteria.every((criterion) => checks.includes(criterion))
                && (candidateGaps.every((gap) => !gap.startsWith("Passing verification")) || acknowledgeGap[issue.id]));
              return <article className="work-issue-card" key={issue.id} id={`work-issue-${issue.id}`}>
                <div className="work-issue-card__top"><span className={`work-issue-status work-issue-status--${issue.status.replace(/[^a-z-]/g, "")}`}>{issue.status}</span><span className="badge-mini">{issue.work_scale}</span><span className="badge-mini">scope r{issue.scope_revision}</span><span className="work-issue-project">{issue.project_id}</span></div>
                <h3>{issue.title}</h3><p>{issue.expected_outcome}</p>
                <div className="work-issue-meta"><span>{issue.acceptance_criteria.length} criterios</span><span>{issue.task_ids.length} tareas</span><span>{issue.classification_rationale.join(" · ")}</span></div>
                <div className="work-issue-scope"><b>Permitido:</b> {issue.authorized_scope.allowed_path_patterns.join(", ")} <span>· {issue.authorized_scope.allowed_change_categories.join(", ")}</span></div>
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
                  {!detail ? <p className="empty-mini">Cargando ejecución y evidencia…</p> : <>
                    <div><b>Intentos:</b> {detail.tasks.flatMap((entry) => entry.executions).map((execution) => `#${execution.attempt} ${execution.run_id.slice(0, 8)}`).join(" · ") || "sin ejecución"}</div>
                    <div><b>Sesiones:</b> {detail.sessions.map((session) => session.objective).join(", ") || "sin sesión vinculada"}</div>
                    <div><b>Brechas de evidencia:</b> {detail.evidence_gaps.length ? detail.evidence_gaps.join(" ") : "sin brechas conocidas"}</div>
                    {detail.candidates.map((candidate) => <div className="work-issue-candidate" key={candidate.id}>
                      <b>{candidate.invalidated_at ? "Candidato invalidado" : "Candidato actual"} · {candidate.candidate_revision.slice(0, 12)}</b>
                      <span>fingerprint {candidate.diff_fingerprint.slice(0, 16)}… · scope r{candidate.scope_revision} · {candidate.changed_paths.join(", ")}</span>
                    </div>)}
                    {manualAllowed && issue.status === "ready-for-review" && currentCandidate && <div className="work-issue-review">
                      <b>Confirmá cada criterio sobre este commit</b>
                      <div className="organization-checkboxes">{issue.acceptance_criteria.map((criterion) => <label key={criterion}><input type="checkbox" checked={checks.includes(criterion)} onChange={(event) => setConfirmed((value) => ({ ...value, [issue.id]: event.target.checked ? [...checks, criterion] : checks.filter((item) => item !== criterion) }))} />{criterion}</label>)}</div>
                      {candidateGaps.some((gap) => gap.startsWith("Passing verification")) && <label className="work-issue-toggle"><input type="checkbox" checked={acknowledgeGap[issue.id] ?? false} onChange={(event) => setAcknowledgeGap((value) => ({ ...value, [issue.id]: event.target.checked }))} />Entiendo y acepto explícitamente la brecha de verificación automatizada</label>}
                      <button className="ibtn primary" disabled={!canAccept || busy === issue.id} onClick={() => void perform(issue.id, () => acceptWorkIssueCandidate(issue, currentCandidate, checks, acknowledgeGap[issue.id] ?? false))}>Aceptar este candidato local</button>
                    </div>}
                    <div className="work-issue-evidence">{detail.evidence.map((entry) => <div key={entry.id}><span className={`evidence-status evidence-status--${entry.status}`}>{entry.status}</span><b>{entry.label}</b><small>{entry.reference}</small></div>)}</div>
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
