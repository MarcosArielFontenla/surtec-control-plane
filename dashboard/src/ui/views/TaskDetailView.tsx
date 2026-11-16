import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, CircleAlert } from "lucide-react";
import type { TaskDetailModel, TaskEvent } from "../../../../lib/state/types";
import type { ClientContextCategory, ClientContextShareAudit } from "../../../../lib/client-portfolio";
import { fetchTaskDetail } from "../api";
import { ContextManifestEvidence, contextDisplayText } from "../components/ContextPreview";

function operatingLabel(task: TaskDetailModel["task"]): string | null {
  if (task.lifecycle === "running") return "Trabajando";
  if (task.lifecycle === "finished" && task.outcome === "blocked") return "Bloqueado";
  if (task.lifecycle === "finished" && ["partial", "failed", "needs-review"].includes(task.outcome ?? "")) return "Necesita decisión";
  return null;
}

function RecordedTesting({ detail }: { detail: TaskDetailModel }) {
  const { task } = detail, receipt = task.testing_evidence, manifest = task.envelope.context_manifest;
  const admission = task.envelope.context_admission;
  const matchingAdmission = admission?.schema_version !== 2 || admission.task_id === task.envelope.id;
  const scopeRevision = admission?.schema_version === 2 ? admission.scope_revision : task.envelope.metadata.issue_scope_revision;
  const matching = !!receipt && !!manifest && !!admission && matchingAdmission
    && receipt.task_id === task.envelope.id && receipt.project_id === task.envelope.project
    && receipt.context_fingerprint === manifest.fingerprint && receipt.context_fingerprint === admission.manifest_fingerprint
    && receipt.issue_id === (admission.issue_id ?? null) && receipt.issue_revision === (admission.issue_revision ?? null)
    && receipt.scope_revision === (typeof scopeRevision === "number" ? scopeRevision : null)
    && (admission.schema_version !== 2 || receipt.scope_fingerprint === admission.scope_fingerprint)
    && (admission.schema_version !== 2 || !admission.candidate || !!receipt.candidate
      && admission.candidate.candidate_id === receipt.candidate.id
      && admission.candidate.repository_id === receipt.project_id && admission.candidate.issue_id === receipt.issue_id
      && admission.candidate.task_id === receipt.task_id && admission.candidate.execution_id === receipt.execution_id
      && admission.candidate.scope_revision === receipt.scope_revision
      && admission.candidate.base_revision === receipt.candidate.base_revision
      && admission.candidate.candidate_revision === receipt.candidate.candidate_revision
      && admission.candidate.diff_fingerprint === receipt.candidate.diff_fingerprint)
    && receipt.mode === manifest.testing.mode;
  return <section className="detail-card panel" aria-label="Testing capturado por infraestructura">
    <h3>Testing capturado por infraestructura</h3>
    <p className="work-issue-note">Los tests declarados por el modelo y el reporte de verificación son hechos separados de este receipt. Ninguno acepta el issue ni confirma por sí solo el Git actual.</p>
    {!receipt ? <p className="empty-mini">No hay receipt de testing registrado; no se infiere aprobación desde un resultado completed o tests declarados.</p> : <>
      <p role="status">{matching ? "Referencias registradas de tarea, contexto y scope coincidentes." : "Referencias del receipt no confirmadas para esta tarea/contexto/scope."}</p>
      <dl className="detail-dl">
        <dt>Receipt / modo</dt><dd>{contextDisplayText(receipt.fingerprint)} · {receipt.mode}</dd>
        <dt>Tarea / ejecución</dt><dd>{contextDisplayText(receipt.task_id)} · {contextDisplayText(receipt.execution_id)}</dd>
        <dt>Proyecto / issue</dt><dd>{contextDisplayText(receipt.project_id)} · {receipt.issue_id ? contextDisplayText(receipt.issue_id) : "Sin issue"}</dd>
        <dt>Scope registrado</dt><dd>{receipt.scope_revision === null ? "Desconocido" : `r${receipt.scope_revision}`} · {receipt.scope_fingerprint ? contextDisplayText(receipt.scope_fingerprint) : "Fingerprint no registrado"}</dd>
        <dt>Contexto registrado</dt><dd>{contextDisplayText(receipt.context_fingerprint)}</dd>
        <dt>Requisitos / observaciones</dt><dd>{receipt.requirements.length} / {receipt.observations.length}</dd>
      </dl>
      {receipt.candidate ? <dl className="detail-dl">
        <dt>Candidato registrado</dt><dd>{contextDisplayText(receipt.candidate.id)}</dd>
        <dt>Base / revisión candidata</dt><dd>{contextDisplayText(receipt.candidate.base_revision)} · {contextDisplayText(receipt.candidate.candidate_revision)}</dd>
        <dt>Fingerprint de diff</dt><dd>{contextDisplayText(receipt.candidate.diff_fingerprint)}</dd>
      </dl> : <p className="empty-mini">Candidato no registrado en el receipt.</p>}
      <p className="work-issue-note">Vigencia actual del candidato: desconocida en esta lectura. Estas referencias no comprueban el sello, el orden completo de testing, la revisión humana ni la autoridad vigente; inspeccioná el issue y su candidato exacto.</p>
      {receipt.observations.length > 0 && <details><summary>Observaciones registradas de testing ({receipt.observations.length})</summary>
        <ul className="detail-list">{receipt.observations.map((entry, index) => <li key={index}>
          {entry.stage} · {entry.outcome} · exit {entry.exit_code ?? "desconocido"} · revisión {contextDisplayText(entry.revision)}
          <div>Inicio {entry.started_at} · fin {entry.finished_at}</div>
          <div>Comando {contextDisplayText(entry.command_fingerprint)} · probe {entry.probe_fingerprint ? contextDisplayText(entry.probe_fingerprint) : "no registrado"}</div>
          <div>{entry.assertions.length} aserciones registradas · árbol {entry.before_fingerprint === entry.after_fingerprint ? "sin cambio observado" : "cambio observado"}</div>
        </li>)}</ul>
      </details>}
    </>}
  </section>;
}

function duration(value: number | null): string {
  if (value === null) return "—";
  const seconds = Math.floor(value / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function value(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function EventRows({ events, empty = "Sin evidencia." }: { events: TaskEvent[]; empty?: string }) {
  if (events.length === 0) return <p className="empty-mini">{empty}</p>;
  return <div className="evidence-list">{events.map((event) => (
    <div className="evidence-row" key={event.event_id}>
      <span className="event-time">{new Date(event.at).toLocaleString("es-AR")}</span>
      <span className="tag approve">{event.type}</span>
      <code>{JSON.stringify(event.payload)}</code>
    </div>
  ))}</div>;
}

function RecordedHistory({ detail }: { detail: TaskDetailModel }) {
  const revision = detail.task.revision;
  const comparable = detail.events.every((event) => event.task_id === detail.task.envelope.id
    && Number.isSafeInteger(event.revision) && event.revision > 0);
  const latest = comparable && detail.events.length > 0
    ? detail.events.reduce((maximum, event) => Math.max(maximum, event.revision), 0) : null;
  let observation = "No hay eventos registrados disponibles; el historial anterior es desconocido.";
  if (!comparable) observation = "No se confirma la correspondencia del historial con esta tarea.";
  else if (latest !== null) {
    if (revision === undefined) observation = "La revisión del snapshot no está registrada; no se puede contrastar con los eventos.";
    else if (latest < revision) observation = "Hay revisiones del snapshot sin un evento observado. Puede tratarse de actualizaciones sin evento o de historial ausente; esta lectura no determina la causa.";
    else if (latest > revision) observation = "Hay eventos posteriores al snapshot leído. Las lecturas no están sincronizadas; no se infiere un estado más reciente.";
    else observation = "Las revisiones observadas coinciden; esto no demuestra un historial completo.";
  }
  return <section className="detail-card panel" aria-label="Historial registrado">
    <h3>Historial registrado</h3>
    <p className="work-issue-note">El snapshot es el estado actual guardado. Los eventos se guardan por separado; la integridad histórica no está confirmada. Recargar o reiniciar no recupera eventos ausentes ni habilita reintentos.</p>
    <dl className="detail-dl"><dt>Snapshot / mayor revisión de evento observada</dt><dd>{revision === undefined ? "Desconocida" : `r${revision}`} / {latest === null ? "No disponible" : `r${latest}`}</dd></dl>
    <p role="status">{observation}</p>
    <EventRows events={detail.events} empty="Sin eventos disponibles en esta lectura." />
  </section>;
}

function StringList({ items, empty = "Sin registros." }: { items: string[]; empty?: string }) {
  return items.length === 0 ? <p className="empty-mini">{empty}</p> : <ul className="detail-list">{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}

const CLIENT_CONTEXT_LABELS: Record<ClientContextCategory, string> = {
  "client-identity": "Identidad del cliente",
  "project-outcome": "Objetivo y próxima acción del proyecto",
  "active-commitments": "Compromisos de entrega activos",
  "service-context": "Criticidad, SLA y próxima revisión",
  "confidential-notes": "Notas confidenciales",
};

export function TaskDetailView({ taskId, onBack, onOpenWorkflow }: { taskId: string; onBack: () => void; onOpenWorkflow?: (target: { issueId: string; workflowId: string; projectId: string }) => void }) {
  const [detail, setDetail] = useState<TaskDetailModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let sequence = 0;
    setDetail(null); setError(null);
    const load = async () => {
      const request = ++sequence;
      try {
        const next = await fetchTaskDetail(taskId);
        if (next.task.envelope.id !== taskId) throw new Error("Mismatched task detail");
        if (active && request === sequence) { setDetail(next); setError(null); }
      } catch {
        if (active && request === sequence) setError("Lectura no confirmada; no se ejecutó ninguna acción.");
      }
    };
    void load();
    const handle = setInterval(load, 3_000);
    return () => { active = false; clearInterval(handle); };
  }, [taskId]);

  if (!detail || detail.task.envelope.id !== taskId) return (
    <div className="detail-shell">
      <button type="button" className="ghost-btn" onClick={onBack}><ArrowLeft /> Volver</button>
      {error ? <div className="banner banner--danger">No pude cargar la tarea ({error}).</div> : <p className="empty-mini">Cargando evidencia…</p>}
    </div>
  );

  const { task, execution } = detail;
  const result = task.result;
  const orchestration = task.orchestration;
  const admission = task.envelope.context_admission;
  const ownedAdmission = admission?.schema_version === 2 && admission.task_id === task.envelope.id ? admission : null;
  const stateLabel = operatingLabel(task);
  const manifest = task.envelope.context_manifest;
  const historicalIssue = typeof task.envelope.metadata.issue_id === "string" ? task.envelope.metadata.issue_id : null;
  const historicalScope = typeof task.envelope.metadata.issue_scope_revision === "number" ? task.envelope.metadata.issue_scope_revision : null;
  const clientShare = task.envelope.metadata.client_context_share;
  const sharedCategories = typeof clientShare === "object" && clientShare !== null
    && Array.isArray((clientShare as ClientContextShareAudit).categories)
    ? (clientShare as ClientContextShareAudit).categories
    : [];
  return (
    <div className="detail-shell">
      <button type="button" className="ghost-btn detail-back" onClick={onBack}><ArrowLeft /> Volver</button>
      {error && <div className="banner banner--warn view-note">No pude refrescar ({error}); mostrando la última evidencia.</div>}

      <section className="detail-hero panel">
        <div><span className="b-label">{task.envelope.project} · {task.envelope.agent}</span><h2>{task.envelope.title}</h2><p>{task.envelope.id}</p></div>
        <span className={`detail-outcome ${task.outcome === "completed" || task.outcome === "partial" ? "ok" : "warn"}`}>
          {task.outcome === "completed" || task.outcome === "partial" ? <CheckCircle2 /> : <CircleAlert />}{task.outcome ?? task.lifecycle}
        </span>
      </section>

      <section className="detail-card panel" aria-label="Estado operativo de la tarea">
        <h3>Estado operativo de la tarea</h3>
        <p>{stateLabel ?? "Sin etiqueta operativa primaria"} · lifecycle {task.lifecycle} · resultado {task.outcome ?? "sin resultado"}</p>
        <p className="work-issue-note">Trabajando, Verificando, Necesita decisión, Listo para revisión, Hecho y Bloqueado son etiquetas de presentación. Esta tarea no acredita Hecho ni aceptación del issue; completed, queued y cancelled conservan su significado original.</p>
        <dl className="detail-dl"><dt>Snapshot de tarea</dt><dd>r{task.revision ?? "desconocida"} · <time dateTime={task.updated_at}>{task.updated_at}</time></dd></dl>
        <p className="work-issue-note">La fecha pertenece al registro de tarea, no al momento del polling ni a una observación actual de Git o del workflow.</p>
        {stateLabel === "Necesita decisión" || stateLabel === "Bloqueado" ? <>
          <p>{orchestration?.last_failure ? `Último fallo registrado: ${orchestration.last_failure.kind}; ejecución ${contextDisplayText(orchestration.last_failure.run_id)} · ${orchestration.last_failure.at}.` : "Motivo exacto no clasificado: falta evidencia estructurada de la decisión o bloqueo."}</p>
          {orchestration?.last_failure && <p className="work-issue-note">La causa concreta de la decisión del issue o el límite aplicable no están confirmados por el tipo de fallo registrado.</p>}
          <p className="work-issue-note">Inspeccioná Riesgos y bloqueos y el issue/workflow propietario. Un fallo histórico no determina el estado actual del issue ni habilita reintentar o ampliar scope.</p>
        </> : null}
      </section>

      <section className="detail-card panel" aria-label="Scope y requisitos registrados">
        <h3>Scope y requisitos registrados</h3>
        <dl className="detail-dl">
          <dt>Proyecto / agente</dt><dd>{contextDisplayText(task.envelope.project)} · {contextDisplayText(task.envelope.agent)}</dd>
          <dt>Issue / scope</dt><dd>{ownedAdmission ? `${ownedAdmission.issue_id} · scope r${ownedAdmission.scope_revision}` : admission?.schema_version === 1 && admission.issue_id ? `${admission.issue_id} · scope ${historicalScope === null ? "desconocido" : `r${historicalScope}`}` : historicalIssue ? `${contextDisplayText(historicalIssue)} · referencia histórica; scope ${historicalScope === null ? "desconocido" : `r${historicalScope}`}` : "Sin binding de issue confirmado"}</dd>
          <dt>Perfil / escala</dt><dd>{manifest ? `${contextDisplayText(manifest.role_id)} · ${manifest.routing.work_scale}` : "No registrados"}</dd>
          <dt>Testing requerido</dt><dd>{manifest ? `${manifest.testing.mode} · RED ${manifest.testing.requires_red_evidence ? "requerido" : "no requerido"}` : "Desconocido: sin manifiesto registrado"}</dd>
          <dt>Revisión requerida</dt><dd>{manifest ? `${manifest.routing.review_depth} · mínimo ${manifest.testing.minimum_review_depth} · QA ${manifest.routing.qa_required ? "requerido" : "no requerido"}` : "Desconocida: sin manifiesto registrado"}</dd>
        </dl>
        {admission?.schema_version === 2 && !ownedAdmission && <p role="alert">La admisión v2 no corresponde a esta tarea; no se usa para inferir ownership, scope o navegación.</p>}
        <p className="work-issue-note">Son requisitos y referencias guardadas, no permisos actuales. El detalle de issue conserva el scope vigente, los criterios y sus acciones protegidas; esta vista no los reconstruye desde instrucciones o metadata histórica.</p>
      </section>

      {ownedAdmission && <section className="detail-card panel" aria-label="Workflow propietario">
        <h3>Workflow propietario</h3><dl className="detail-dl"><dt>Workflow / issue</dt><dd>{ownedAdmission.workflow_id} · {ownedAdmission.issue_id}</dd><dt>Etapa / rol</dt><dd>{ownedAdmission.stage_id} · {ownedAdmission.stage_kind} · {ownedAdmission.role_id} · generación {ownedAdmission.stage_generation}</dd><dt>Autoridad admitida</dt><dd>{ownedAdmission.grant_id} · r{ownedAdmission.authority_revision} · scope r{ownedAdmission.scope_revision}</dd><dt>Predecesor / handoff</dt><dd>{ownedAdmission.predecessor_stage_id ?? "No registrado"} · {ownedAdmission.handoff_id ?? "No registrado"}</dd><dt>Scope fingerprint</dt><dd>{ownedAdmission.scope_fingerprint}</dd></dl>
        <p className="work-issue-note">Este binding registra la admisión, no demuestra autoridad actual. Reintentos, decisiones y stop se gestionan en el workflow; no publica ni limpia su candidato.</p>
        {ownedAdmission.candidate && <p className="work-issue-note">Candidato admitido {ownedAdmission.candidate.candidate_id} · revisión {ownedAdmission.candidate.candidate_revision} · ejecución {ownedAdmission.candidate.execution_id}. Es una referencia de admisión, no una comprobación actual de Git.</p>}
        {onOpenWorkflow && <button type="button" className="ibtn" onClick={() => onOpenWorkflow({ issueId: ownedAdmission.issue_id, workflowId: ownedAdmission.workflow_id, projectId: task.envelope.project })}>Abrir workflow del issue</button>}
      </section>}

      <section className="detail-stats">
        <div className="panel"><span className="b-label">Lifecycle</span><b>{task.lifecycle}</b></div>
        <div className="panel"><span className="b-label">Duración</span><b>{duration(detail.duration_ms)}</b></div>
        <div className="panel"><span className="b-label">Intentos</span><b>{orchestration?.attempts ?? "Desconocidos"}/{orchestration?.max_attempts ?? "—"}</b></div>
        <div className="panel"><span className="b-label">Tokens</span><b>{orchestration?.cumulative_tokens ?? "Desconocidos"}/{orchestration?.max_total_tokens ?? "—"}</b><p className="work-issue-note">Acumulado registrado, no costo ni prueba de contabilidad completa del workflow.</p></div>
        <div className="panel"><span className="b-label">Cleanup</span><b>{detail.cleanup.status}</b></div>
      </section>

      <section className="detail-card panel" aria-label="Manifiesto de contexto">
        <h3>Manifiesto de contexto</h3>
        {task.envelope.context_manifest ? <ContextManifestEvidence manifest={task.envelope.context_manifest} />
          : <p className="empty-mini">Tarea histórica sin manifiesto registrado. No se infieren perfil, consentimiento ni requisitos de contexto.</p>}
      </section>

      <RecordedTesting detail={detail} />

      {sharedCategories.length > 0 && (
        <section className="detail-card panel">
          <h3>Contexto de cliente compartido</h3>
          <p className="client-portfolio-note">Registro de categorías seleccionadas explícitamente; no conserva razonamiento interno.</p>
          <StringList items={sharedCategories.map((category) => CLIENT_CONTEXT_LABELS[category] ?? "Categoría desconocida")} />
        </section>
      )}

      <div className="detail-grid">
        <section className="detail-card panel"><h3>Resultado</h3><p className="detail-summary">{result?.summary ?? "Todavía no hay resultado estructurado."}</p><span className="b-label">Archivos</span><StringList items={result?.files_changed ?? []} /></section>
        <section className="detail-card panel"><h3>Ejecución</h3><dl className="detail-dl">
          <dt>Modo</dt><dd>{value(execution.mode)}</dd><dt>Thread</dt><dd>{value(execution.thread_id)}</dd><dt>Turn</dt><dd>{value(execution.turn_id)}</dd>
          <dt>Branch</dt><dd>{value(execution.branch)}</dd><dt>Commit</dt><dd>{value(execution.committed)}</dd><dt>Diffstat</dt><dd>{value(execution.diffstat)}</dd>
          <dt>Trace</dt><dd>{execution.trace_id ? `${execution.trace_id} / ${execution.span_id ?? "—"}` : "no habilitado"}</dd>
        </dl></section>
      </div>

      <section className="detail-card panel"><h3>Diff <span className="meta">{detail.diff.status}{detail.diff.truncated ? " · truncado" : ""}</span></h3>{detail.diff.content ? <pre className="diff-view">{detail.diff.content}</pre> : <p className="empty-mini">No hay diff disponible.</p>}</section>

      <div className="detail-grid">
        <section className="detail-card panel"><h3>Comandos</h3><StringList items={result?.commands_run ?? []} /><h3 className="detail-subhead">Tests declarados</h3><p className="work-issue-note">Declaración del modelo; no sustituye un receipt de infraestructura ni la aceptación humana.</p><StringList items={result?.tests_run ?? []} /></section>
        <section className="detail-card panel"><h3>Verificación</h3>{!result?.verification ? <p className="empty-mini">No solicitada.</p> : <><p className={`verification-state ${result.verification.status}`}>{result.verification.status}</p>{result.verification.checks.map((check) => <div className="verify-check" key={check.command}><b>{check.ok ? "✓" : "×"} {check.command}</b>{check.output_tail && <pre>{check.output_tail}</pre>}</div>)}</>}</section>
      </div>

      <div className="detail-grid">
        <section className="detail-card panel"><h3>Policy</h3><EventRows events={detail.policy_decisions} /></section>
        <section className="detail-card panel"><h3>Approvals</h3><EventRows events={detail.approvals} /></section>
        <section className="detail-card panel"><h3>Uso</h3><EventRows events={detail.usage} /></section>
        <section className="detail-card panel"><h3>Reintentos y recovery</h3><EventRows events={detail.retries} /></section>
      </div>

      <div className="detail-grid">
        <section className="detail-card panel"><h3>Revisión y cleanup</h3><EventRows events={detail.review_history} /><dl className="detail-dl detail-cleanup"><dt>Estado</dt><dd>{detail.cleanup.status}</dd><dt>Última evidencia</dt><dd>{detail.cleanup.at ? new Date(detail.cleanup.at).toLocaleString("es-AR") : "—"}</dd></dl></section>
        <section className="detail-card panel"><h3>Riesgos y bloqueos</h3><span className="b-label">Riesgos</span><StringList items={result?.risks ?? []} /><span className="b-label">Bloqueos</span><StringList items={result?.blockers ?? []} /><span className="b-label">Próximos pasos</span><StringList items={result?.next_steps ?? []} /></section>
      </div>

      <RecordedHistory detail={detail} />
    </div>
  );
}
