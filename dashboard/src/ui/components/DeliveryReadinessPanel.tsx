import { useEffect, useRef, useState, type FormEvent } from "react";
import type { DeliveryObservation, IssueEvidenceReference, IssueLineage, RecordDeliveryObservationInput, ReviewCandidate, WorkIssue } from "../../../../lib/issues/types";
import { isSafeIdentifier } from "../../../../lib/security/identifiers";
import { getWorkIssue, getWorkIssues, recordDeliveryObservation } from "../api";

export interface DeliveryReadinessPanelProps {
  projectId: string;
  lineage?: IssueLineage;
  commitmentId?: string;
  disabled?: boolean;
  onChanged?: () => Promise<unknown> | void;
}

const kinds = ["readiness-reviewed", "environment-observed", "handoff-recorded", "client-response-recorded", "follow-up-recorded"] as const;
const labels: Record<DeliveryObservation["kind"], string> = {
  "readiness-reviewed": "Readiness revisada", "environment-observed": "Entorno observado", "handoff-recorded": "Handoff registrado",
  "client-response-recorded": "Respuesta registrada", "follow-up-recorded": "Seguimiento registrado",
};
const observationKeys = ["schema_version", "kind", "origin", "commitment_id", "occurred_at", "summary", "source_reference", "next_action"];
const issueId = (value: unknown): value is string => typeof value === "string" && /^I-[A-Fa-f0-9-]{36}$/.test(value);
const candidateId = (value: unknown): value is string => typeof value === "string" && /^C-[A-Fa-f0-9-]{36}$/.test(value);
const evidenceId = (value: unknown): value is string => typeof value === "string" && /^E-[A-Fa-f0-9-]{36}$/.test(value);
const fingerprint = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]! && Number(value.slice(11, 13)) <= 23
    && Number(value.slice(14, 16)) <= 59 && Number(value.slice(17, 19)) <= 59;
}
const bounded = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length <= maximum && /\S/.test(value);
function sourceReference(value: unknown): value is string {
  if (!bounded(value, 300) || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) return true;
  if (!/^https?:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/.test(value)) return false;
  try { const parsed = new URL(value); return ["http:", "https:"].includes(parsed.protocol) && !!parsed.hostname && !parsed.username && !parsed.password && !parsed.search && !parsed.hash; }
  catch { return false; }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).every(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return typeof key === "string" && !!descriptor?.enumerable && "value" in descriptor; });
}
function observation(value: unknown): value is DeliveryObservation {
  if (!object(value) || Object.keys(value).length !== observationKeys.length || !observationKeys.every(key => Object.hasOwn(value, key))) return false;
  return value.schema_version === 1 && kinds.includes(value.kind as DeliveryObservation["kind"]) && value.origin === "operator-entered"
    && (value.commitment_id === null || isSafeIdentifier(value.commitment_id)) && timestamp(value.occurred_at)
    && bounded(value.summary, 500) && bounded(value.next_action, 500) && sourceReference(value.source_reference)
    && [value.summary, value.next_action].every(text => text === text.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text));
}
function issueSummary(value: unknown, projectId: string, commitmentId?: string): value is WorkIssue {
  if (!object(value)) return false;
  return value.schema_version === 1 && issueId(value.id) && value.project_id === projectId && positive(value.revision) && positive(value.scope_revision)
    && typeof value.status === "string" && ["proposed", "authorized", "working", "checking", "ready-for-review", "blocked", "needs-decision", "done", "cancelled"].includes(value.status)
    && Array.isArray(value.candidate_ids) && value.candidate_ids.length <= 100 && value.candidate_ids.every(candidateId) && new Set(value.candidate_ids).size === value.candidate_ids.length
    && Array.isArray(value.evidence_ids) && value.evidence_ids.length <= 500 && value.evidence_ids.every(evidenceId) && new Set(value.evidence_ids).size === value.evidence_ids.length
    && Array.isArray(value.task_ids) && value.task_ids.length <= 100 && value.task_ids.every(isSafeIdentifier)
    && Array.isArray(value.related_commitment_ids) && value.related_commitment_ids.length <= 100 && value.related_commitment_ids.every(isSafeIdentifier)
    && (!commitmentId || value.related_commitment_ids.includes(commitmentId));
}
function candidate(value: unknown, issue: WorkIssue): value is ReviewCandidate {
  return object(value) && value.schema_version === 1 && candidateId(value.id) && value.issue_id === issue.id && value.repository_id === issue.project_id
    && issue.candidate_ids.includes(value.id) && isSafeIdentifier(value.task_id) && isSafeIdentifier(value.execution_id)
    && bounded(value.candidate_revision, 100) && fingerprint(value.diff_fingerprint) && positive(value.scope_revision)
    && (value.invalidated_at === null || timestamp(value.invalidated_at));
}
function exactLineage(value: unknown, projectId: string, expectedId?: string, commitmentId?: string): value is IssueLineage {
  if (!object(value) || !issueSummary(value.issue, projectId, commitmentId) || expectedId && value.issue.id !== expectedId) return false;
  const issue = value.issue, candidates = value.candidates, evidence = value.evidence, tasks = value.tasks;
  return Array.isArray(candidates) && candidates.length <= 100 && candidates.every(entry => candidate(entry, issue))
    && new Set(candidates.map(entry => entry.id)).size === candidates.length
    && issue.candidate_ids.every(id => candidates.some(entry => entry.id === id))
    && Array.isArray(evidence) && evidence.length <= 500 && evidence.every(entry => object(entry) && evidenceId(entry.id) && entry.issue_id === issue.id && issue.evidence_ids.includes(entry.id))
    && new Set(evidence.map(entry => entry.id)).size === evidence.length && issue.evidence_ids.every(id => evidence.some(entry => entry.id === id))
    && Array.isArray(tasks) && tasks.length <= 100 && tasks.every(entry => object(entry) && object(entry.task) && object(entry.task.envelope)
      && isSafeIdentifier(entry.task.envelope.id) && entry.task.envelope.project === projectId && issue.task_ids.includes(entry.task.envelope.id)
      && ["queued", "running", "finished"].includes(entry.task.lifecycle as string));
}
function manualRecord(entry: IssueEvidenceReference, detail: IssueLineage): boolean {
  if (!observation(entry.delivery_observation) || entry.schema_version !== 1 || entry.issue_id !== detail.issue.id || !evidenceId(entry.id)
    || entry.task_id !== null || entry.execution_id !== null || !["work-product", "provider"].includes(entry.kind) || entry.status !== "informational"
    || Object.hasOwn(entry, "testing_evidence_fingerprint") || !positive(entry.scope_revision) || entry.scope_revision > detail.issue.scope_revision || !timestamp(entry.created_at)
    || Date.parse(entry.delivery_observation.occurred_at) > Date.parse(entry.created_at)) return false;
  if (entry.candidate_id === null) return entry.candidate_revision === null && entry.diff_fingerprint === null;
  const bound = detail.candidates.find(value => value.id === entry.candidate_id);
  return !!bound && bound.scope_revision === entry.scope_revision && bound.candidate_revision === entry.candidate_revision && bound.diff_fingerprint === entry.diff_fingerprint;
}
function currentCandidate(detail: IssueLineage): ReviewCandidate | undefined {
  return detail.candidates.find(value => value.id === detail.issue.candidate_ids.at(-1) && value.invalidated_at === null && value.scope_revision === detail.issue.scope_revision);
}
function technicalEvidence(entry: IssueEvidenceReference, bound: ReviewCandidate): boolean {
  return !Object.hasOwn(entry, "delivery_observation") && entry.schema_version === 1 && entry.issue_id === bound.issue_id && entry.candidate_id === bound.id
    && entry.task_id === bound.task_id && entry.execution_id === bound.execution_id && entry.candidate_revision === bound.candidate_revision
    && entry.diff_fingerprint === bound.diff_fingerprint && entry.scope_revision === bound.scope_revision && timestamp(entry.created_at);
}
interface Draft { kind: DeliveryObservation["kind"]; occurred: string; summary: string; reference: string; next: string; candidate: string; commitment: string }
const emptyDraft = (): Draft => ({ kind: "readiness-reviewed", occurred: "", summary: "", reference: "", next: "", candidate: "", commitment: "" });
interface PanelState {
  key: string; expanded: boolean; pending: boolean; issues?: WorkIssue[]; truncated?: boolean; selected: string; detail?: IssueLineage;
  form: boolean; draft: Draft; confirmed: boolean; revealed: string[]; warning?: string; message?: string; needsRefresh: boolean;
}
const initial = (key: string): PanelState => ({ key, expanded: false, pending: false, selected: "", form: false, draft: emptyDraft(), confirmed: false, revealed: [], needsRefresh: false });

export function DeliveryReadinessPanel({ projectId, lineage, commitmentId, disabled = false, onChanged }: DeliveryReadinessPanelProps) {
  const supplied = lineage?.issue, lastId = Array.isArray(supplied?.candidate_ids) ? supplied.candidate_ids.at(-1) : undefined;
  const last = Array.isArray(lineage?.candidates) ? lineage.candidates.find(entry => entry?.id === lastId) : undefined;
  const commitmentKey = Array.isArray(supplied?.related_commitment_ids) ? supplied.related_commitment_ids.join(",") : "";
  const key = `${projectId}|${commitmentId ?? ""}|${supplied?.id ?? ""}|${supplied?.revision ?? ""}|${supplied?.scope_revision ?? ""}|${lastId ?? ""}|${last?.candidate_revision ?? ""}|${last?.diff_fingerprint ?? ""}|${last?.invalidated_at ?? ""}|${last?.scope_revision ?? ""}|${last?.repository_id ?? ""}|${last?.task_id ?? ""}|${last?.execution_id ?? ""}|${commitmentKey}`;
  const [state, setState] = useState<PanelState>(() => initial(key));
  const sequence = useRef(0), activeKey = useRef(key), mounted = useRef(true), submitting = useRef(false);
  activeKey.current = key;
  const view = state.key === key ? state : initial(key);
  const update = (change: Partial<PanelState>) => setState(previous => previous.key === key ? { ...previous, ...change } : previous);
  const live = (request: number) => mounted.current && sequence.current === request && activeKey.current === key;
  useEffect(() => { mounted.current = true; sequence.current++; setState(initial(key)); return () => { mounted.current = false; sequence.current++; }; }, [key]);
  useEffect(() => { setState(previous => ({ ...previous, confirmed: false })); }, [disabled]);
  const detail = view.detail, bound = detail ? currentCandidate(detail) : undefined;
  const facets = detail?.evidence.filter(entry => Object.hasOwn(entry, "delivery_observation")) ?? [];
  const validRecords = detail ? facets.filter(entry => manualRecord(entry, detail)) : [];
  const records = validRecords.filter(entry => !commitmentId || entry.delivery_observation!.commitment_id === commitmentId);
  const gap = facets.length !== validRecords.length || facets.length > 64;
  const taskUnknown = !!detail && detail.issue.task_ids.some(id => !detail.tasks.some(entry => entry.task.envelope.id === id));
  const taskActive = detail?.tasks.some(entry => entry.task.lifecycle === "queued" || entry.task.lifecycle === "running");
  const canRecord = !!detail && !disabled && !view.pending && !submitting.current && !view.needsRefresh && !gap && !taskUnknown && !taskActive && facets.length < 64 && detail.issue.evidence_ids.length < 500;

  async function consult(refresh = false) {
    if (view.pending || submitting.current) return;
    const request = ++sequence.current;
    update({ expanded: true, pending: true, form: false, confirmed: false, revealed: [], warning: undefined, message: undefined, needsRefresh: false, draft: emptyDraft() });
    try {
      if (!isSafeIdentifier(projectId) || commitmentId && !isSafeIdentifier(commitmentId)) throw new Error("context");
      if (lineage) {
        const result = refresh ? await getWorkIssue(lineage.issue.id) : lineage;
        if (!live(request)) return;
        if (!exactLineage(result, projectId, lineage.issue.id, commitmentId)) throw new Error("binding");
        update({ pending: false, detail: result, selected: result.issue.id });
      } else {
        const result = await getWorkIssues();
        if (!live(request)) return;
        if (!object(result) || !Array.isArray(result.issues) || result.issues.length > 500) throw new Error("issues");
        const sameProject = result.issues.filter(entry => object(entry) && entry.project_id === projectId);
        if (!sameProject.every(entry => issueSummary(entry, projectId))) throw new Error("issue-contract");
        const matching = sameProject.filter(entry => !commitmentId || entry.related_commitment_ids.includes(commitmentId));
        if (new Set(matching.map(entry => entry.id)).size !== matching.length) throw new Error("duplicate");
        update({ pending: false, detail: undefined, selected: "", issues: matching.slice(0, 50), truncated: matching.length > 50 });
      }
    } catch {
      if (live(request)) update({ pending: false, detail: undefined, issues: undefined, selected: "", needsRefresh: true, warning: "No se pudo confirmar la evidencia de entrega. Actualizá explícitamente antes de registrar; no se ejecutó otra acción." });
    }
  }
  async function selectIssue(id: string) {
    if (view.pending || submitting.current) return;
    const expected = view.issues?.find(entry => entry.id === id), request = ++sequence.current;
    update({ selected: id, detail: undefined, pending: !!expected, form: false, draft: emptyDraft(), confirmed: false, revealed: [], warning: undefined, message: undefined, needsRefresh: false });
    if (!expected) return;
    try {
      const result = await getWorkIssue(id);
      if (!live(request)) return;
      if (!exactLineage(result, projectId, id, commitmentId) || result.issue.revision !== expected.revision || result.issue.scope_revision !== expected.scope_revision) throw new Error("stale");
      update({ pending: false, detail: result });
    } catch {
      if (live(request)) update({ pending: false, needsRefresh: true, warning: "El issue cambió o su evidencia no pudo confirmarse. Actualizá la consulta y volvé a elegirlo; no se registró otra acción." });
    }
  }
  function change(field: keyof Draft, value: string) {
    update({ draft: { ...view.draft, [field]: value }, confirmed: false, message: undefined });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canRecord || !detail || !view.confirmed || submitting.current) return;
    const date = new Date(view.draft.occurred), selectedCandidate = view.draft.candidate ? bound?.id === view.draft.candidate ? bound : undefined : undefined;
    const chosenCommitment = commitmentId ?? (view.draft.commitment || null);
    const localParts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?$/.exec(view.draft.occurred);
    const exactLocalTime = !!localParts && [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()]
      .every((part, index) => part === Number(localParts[index + 1] ?? 0));
    if (!exactLocalTime || !Number.isFinite(date.getTime()) || date.getTime() > Date.now() || view.draft.candidate && !selectedCandidate
      || chosenCommitment && !detail.issue.related_commitment_ids.includes(chosenCommitment)) {
      update({ confirmed: false, warning: "Revisá el momento y los vínculos explícitos antes de confirmar. No se guardó una observación." }); return;
    }
    const input: RecordDeliveryObservationInput = {
      project_id: projectId, expected_revision: detail.issue.revision, scope_revision: detail.issue.scope_revision,
      candidate_id: selectedCandidate?.id ?? null, candidate_revision: selectedCandidate?.candidate_revision ?? null, diff_fingerprint: selectedCandidate?.diff_fingerprint ?? null,
      delivery_observation: { schema_version: 1, kind: view.draft.kind, origin: "operator-entered", commitment_id: chosenCommitment, occurred_at: date.toISOString(),
        summary: view.draft.summary, source_reference: view.draft.reference, next_action: view.draft.next }, confirm: true,
    };
    if (!observation(input.delivery_observation)) { update({ confirmed: false, warning: "Completá los campos privados y una referencia de origen válida. No se guardó una observación." }); return; }
    submitting.current = true;
    const request = ++sequence.current;
    update({ pending: true, confirmed: false, warning: undefined, message: undefined, revealed: [] });
    try {
      const result = await recordDeliveryObservation(detail.issue.id, input);
      if (!live(request)) return;
      if (!object(result) || !issueSummary(result.issue, projectId, commitmentId) || result.issue.id !== detail.issue.id
        || result.issue.revision !== detail.issue.revision + 1 || result.issue.scope_revision !== detail.issue.scope_revision || result.issue.status !== detail.issue.status
        || !object(result.evidence) || !evidenceId(result.evidence.id) || detail.issue.evidence_ids.includes(result.evidence.id)
        || !result.issue.evidence_ids.includes(result.evidence.id)) throw new Error("response");
      const saved = result.evidence as unknown as IssueEvidenceReference;
      if (!manualRecord(saved, { ...detail, issue: result.issue }) || saved.candidate_id !== input.candidate_id || saved.candidate_revision !== input.candidate_revision
        || saved.diff_fingerprint !== input.diff_fingerprint || saved.scope_revision !== input.scope_revision
        || !observationKeys.every(field => saved.delivery_observation![field as keyof DeliveryObservation] === input.delivery_observation[field as keyof DeliveryObservation])) throw new Error("response-binding");
      const fresh = await getWorkIssue(detail.issue.id);
      if (!live(request)) return;
      if (!exactLineage(fresh, projectId, detail.issue.id, commitmentId) || fresh.issue.revision < result.issue.revision
        || !fresh.evidence.some(entry => entry.id === saved.id && manualRecord(entry, fresh) && entry.candidate_id === saved.candidate_id
          && entry.candidate_revision === saved.candidate_revision && entry.diff_fingerprint === saved.diff_fingerprint && entry.scope_revision === saved.scope_revision
          && observationKeys.every(field => entry.delivery_observation![field as keyof DeliveryObservation] === saved.delivery_observation![field as keyof DeliveryObservation]))) throw new Error("reread");
      update({ pending: false, detail: fresh, form: false, draft: emptyDraft(), confirmed: false, revealed: [], needsRefresh: false, message: "Observación local registrada. No se aprobó entrega ni se completó un compromiso." });
      if (live(request)) {
        try { await onChanged?.(); } catch { if (live(request)) update({ warning: "La observación se registró, pero otra vista no pudo actualizarse. Actualizá explícitamente antes de continuar.", needsRefresh: true }); }
      }
    } catch {
      if (live(request)) update({ pending: false, confirmed: false, needsRefresh: true, warning: "No se pudo confirmar el resultado del registro. No se reintentó: actualizá explícitamente y revisá el historial antes de volver a registrar." });
    } finally { submitting.current = false; if (mounted.current) setState(previous => ({ ...previous })); }
  }

  const verification = bound ? detail?.evidence.filter(entry => technicalEvidence(entry, bound) && entry.kind === "verification" && entry.status === "passed") ?? [] : [];
  const reviews = bound ? detail?.evidence.filter(entry => technicalEvidence(entry, bound) && entry.kind === "review" && entry.status === "passed") ?? [] : [];
  return <section className="delivery-readiness panel" aria-label="Entrega y seguimiento">
    <div className="section-head delivery-readiness-actions"><div><h3>Entrega y seguimiento</h3><p>Hechos independientes; ninguna observación manual concede permisos ni acredita aceptación técnica.</p></div>
      <button className="ibtn" type="button" disabled={view.pending || submitting.current} onClick={() => void consult(view.expanded)}>{view.pending ? "Consultando entrega…" : view.expanded ? "Actualizar entrega y seguimiento" : "Consultar entrega y seguimiento"}</button></div>
    <p>Trabajo personal o experimental: cliente, release y handoff son opcionales. No se infiere entrega por un build saludable, una URL o un workflow completado.</p>
    {view.warning && <p className="delivery-readiness-warning" role="status">{view.warning}</p>}
    {view.message && <p role="status">{view.message}</p>}
    {view.expanded && !lineage && view.issues && <>
      {view.truncated && <p className="delivery-readiness-warning">Cobertura parcial: se muestran como máximo 50 issues vinculados. Los restantes no fueron seleccionados ni evaluados.</p>}
      {view.issues.length === 0 ? <p>Sin issues locales vinculados en esta consulta. El trabajo personal no requiere cliente ni release.</p> : <label>Issue de entrega
        <select aria-label="Issue de entrega" value={view.selected} disabled={view.pending} onChange={event => void selectIssue(event.target.value)}><option value="">Elegir un issue explícitamente</option>{view.issues.map(issue => <option key={issue.id} value={issue.id}>{issue.id} · {issue.status} · revisión {issue.revision}</option>)}</select></label>}
    </>}
    {view.expanded && detail && <>
      <p>Issue {detail.issue.id} · proyecto {projectId} · revisión {detail.issue.revision} · scope {detail.issue.scope_revision}{commitmentId ? ` · compromiso ${commitmentId}` : " · sin compromiso obligatorio"}.</p>
      <div className="delivery-readiness-facts">
        <section aria-label="Aceptación técnica"><h4>Aceptación técnica</h4>
          <p>Estado local: {detail.issue.status === "done" ? "Hecho (done)" : detail.issue.status}. El estado por sí solo no prueba aceptación exacta ni entrega.</p>
          {bound ? <><p>Candidato local actual {bound.id} · revisión {bound.candidate_revision} · fingerprint {bound.diff_fingerprint} · scope {bound.scope_revision}.</p>
            <p>Verificación vinculada: {verification.length ? `${verification.length} registro(s) passed` : "sin registro passed exacto"}. Revisión vinculada: {reviews.length ? `${reviews.length} registro(s) passed` : "sin registro passed exacto"}.</p>
            <p>{verification.some(entry => fingerprint(entry.testing_evidence_fingerprint)) ? "Existe una referencia de receipt de testing; este panel no vuelve a validarlo." : "Receipt de testing exacto no confirmado; las referencias históricas no fabrican uno."}</p>
            <p>Las referencias por sí solas no acreditan aceptación humana exacta; revisá el gate y la evidencia del issue. Vigencia frente al Git actual: desconocida; no se inspecciona aquí.</p>
          </> : <p>Sin candidato actual confirmado: la aceptación técnica exacta no está acreditada. No se deduce de tareas finalizadas.</p>}
        </section>
        {kinds.map(kind => { const facts = records.filter(entry => entry.delivery_observation!.kind === kind); return <section key={kind} aria-label={labels[kind]}><h4>{labels[kind]}</h4>
          <p>{facts.length ? `${facts.length} observación(es) manual(es), no validación independiente.` : gap ? "No disponible: hay una observación incompatible o incompleta; no se asume ausencia ni éxito." : "Sin observación registrada; no implica éxito ni fallo."}</p>
          {kind === "follow-up-recorded" && <p>Registrar seguimiento no confirma que esté abierto o cerrado, ni cierra issues o compromisos.</p>}
          {facts.slice(0, 64).map(entry => <article className="delivery-readiness-record" key={entry.id}>
            <p>Evidencia {entry.id} · origen manual del operador (operator-entered) · informativa, no aprobación.</p>
            <p>Observado: <time dateTime={entry.delivery_observation!.occurred_at}>{entry.delivery_observation!.occurred_at}</time> · registrado: <time dateTime={entry.created_at}>{entry.created_at}</time>.</p>
            <p>Scope histórico {entry.scope_revision} · candidato {entry.candidate_id ?? "sin vínculo explícito"}{entry.candidate_id ? ` · revisión ${entry.candidate_revision} · fingerprint ${entry.diff_fingerprint}` : ""} · compromiso {entry.delivery_observation!.commitment_id ?? "sin vínculo explícito"}.</p>
            <button className="ghost-btn" type="button" aria-expanded={view.revealed.includes(entry.id)} onClick={() => update({ revealed: view.revealed.includes(entry.id) ? view.revealed.filter(id => id !== entry.id) : [...view.revealed, entry.id] })}>{view.revealed.includes(entry.id) ? "Ocultar detalle privado" : "Mostrar detalle privado"} {entry.id}</button>
            {view.revealed.includes(entry.id) && <dl><dt>Resumen privado</dt><dd>{entry.delivery_observation!.summary}</dd><dt>Referencia de origen (solo texto)</dt><dd>{entry.delivery_observation!.source_reference}</dd><dt>Próxima acción privada</dt><dd>{entry.delivery_observation!.next_action}</dd></dl>}
          </article>)}
        </section>; })}
      </div>
      {gap && <p className="delivery-readiness-warning">Brecha de evidencia: hay metadata manual inválida, incompatible o fuera de capacidad. Se preserva como no disponible y se impide registrar desde esta lectura.</p>}
      <p>Capacidad manual registrada: {facets.length}/64. No se editan ni eliminan hechos anteriores y no se actualiza el estado de compromisos.</p>
      {(taskActive || taskUnknown || disabled) && <p className="delivery-readiness-warning">Registro no disponible: la operación actual o su ownership no permiten confirmarlo. El servidor vuelve a comprobar tareas y workflows antes de escribir.</p>}
      <div className="delivery-readiness-actions"><button className="ibtn" type="button" disabled={!canRecord} onClick={() => update({ form: !view.form, draft: emptyDraft(), confirmed: false, warning: undefined, message: undefined })}>{view.form ? "Cancelar registro manual" : "Registrar observación manual"}</button></div>
      {view.form && <form className="delivery-readiness-form" aria-label="Registrar observación de entrega" onSubmit={event => void save(event)} autoComplete="off">
        <fieldset disabled={!canRecord}><legend>Hecho local explícito</legend>
          <label>Tipo de observación<select aria-label="Tipo de observación" value={view.draft.kind} onChange={event => change("kind", event.target.value)}>{kinds.map(kind => <option key={kind} value={kind}>{labels[kind]}</option>)}</select></label>
          <label>Momento de la observación (hora local)<input aria-label="Momento de la observación (hora local)" required type="datetime-local" value={view.draft.occurred} onChange={event => change("occurred", event.target.value)} /></label>
          <p>Elegí el momento realmente observado; se convierte a UTC. La fecha de registro la fija el servidor, sin backfill.</p>
          <label>Resumen privado<textarea aria-label="Resumen privado" required maxLength={500} value={view.draft.summary} onChange={event => change("summary", event.target.value)} /></label>
          <label>Referencia de origen<input aria-label="Referencia de origen" required maxLength={300} value={view.draft.reference} onChange={event => change("reference", event.target.value)} /></label>
          <p>Identificador opaco o HTTP(S) simple sin credenciales, query ni fragmento. Es texto: no se abre, ejecuta ni consulta.</p>
          <label>Próxima acción privada<textarea aria-label="Próxima acción privada" required maxLength={500} value={view.draft.next} onChange={event => change("next", event.target.value)} /></label>
          <label>Candidato relacionado<select aria-label="Candidato relacionado" value={view.draft.candidate} onChange={event => change("candidate", event.target.value)}><option value="">Sin candidato explícito</option>{bound && <option value={bound.id}>{bound.id} · {bound.candidate_revision}</option>}</select></label>
          <label>Compromiso relacionado<select aria-label="Compromiso relacionado" value={commitmentId ?? view.draft.commitment} disabled={!!commitmentId} onChange={event => change("commitment", event.target.value)}><option value="">Sin compromiso explícito</option>{detail.issue.related_commitment_ids.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
          <p>Los campos privados quedan en este hecho local. No se comparten con modelos, resúmenes ni prefills de tareas.</p>
          <label className="delivery-readiness-confirm"><input type="checkbox" checked={view.confirmed} onChange={event => update({ confirmed: event.target.checked })} />Confirmo registrar este hecho manual sin aprobar entrega ni completar compromisos</label>
          <div className="delivery-readiness-actions"><button className="ibtn" type="submit" disabled={!canRecord || !view.confirmed}>Guardar observación local</button></div>
        </fieldset>
      </form>}
    </>}
  </section>;
}
