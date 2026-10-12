import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectView } from "../../../../lib/state/types";
import type { Objective } from "../../../../lib/organization";
import type { RoutineAction, RoutineCatchUp, RoutineConcurrency, RoutineRecord, RoutineScope } from "../../../../lib/routines/types";
import {
  configureRoutine, createRoutine, disableRoutine, fetchRoutine, fetchRoutines, getOrganization, runRoutine,
  type RoutineConfigureInput, type RoutineDetail, type RoutineList, type RoutineOccurrenceSummary,
} from "../api";
import { contextDisplayText } from "./ContextPreview";

const ACTION_LABELS: Record<RoutineAction, string> = {
  "refresh-evidence": "Actualizar evidencia", "evaluate-signals": "Evaluar señales",
  "propose-issues": "Proponer issues para revisión", "generate-local-report": "Generar informe local",
};
const NEXT_ACTIONS = { none: "Sin acción pendiente", "inspect-evidence": "Inspeccionar evidencia",
  "review-proposals": "Revisar propuestas", "inspect-budget": "Inspeccionar presupuesto",
  "resolve-ownership": "Resolver ownership", "run-new-occurrence": "Revisar una nueva ejecución explícita" };
const STATUS_LABELS = { reserved: "Reservada", running: "En ejecución", completed: "Completada", partial: "Parcial",
  failed: "Fallida", cancelled: "Cancelada", "needs-review": "Requiere revisión" };
const FRESHNESS_LABELS = { fresh: "Fresca al capturar", partial: "Parcial", stale: "Obsoleta", unavailable: "No disponible" };
const DISPLAY_LIMIT = 25;
const safe = contextDisplayText;
function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$(?![\s\S])/.test(value)
    && !value.includes("..") && !["constructor", "prototype", "__proto__"].includes(value);
}
function recordKey(record: RoutineRecord): string { return JSON.stringify(record); }
interface Draft {
  action: RoutineAction; scopeKind: RoutineScope["kind"]; scopeId: string; enabled: boolean;
  schedule: "manual" | "interval"; minutes: string; concurrency: RoutineConcurrency; catchUp: RoutineCatchUp;
}
type Operation = "creación" | "configuración" | "ejecución" | "deshabilitación";
interface Confirmation { operation: Operation; id: string | null; revision: number | null; draftKey: string; bindingKey: string | null }
const initialDraft = (): Draft => ({ action: "refresh-evidence", scopeKind: "company", scopeId: "surtec", enabled: false,
  schedule: "manual", minutes: "15", concurrency: "skip", catchUp: "skip-missed" });
function recordDraft(record: RoutineRecord): Draft {
  return { action: record.action, scopeKind: record.scope.kind, scopeId: record.scope.id, enabled: record.enabled,
    schedule: record.schedule === null ? "manual" : "interval", minutes: record.schedule?.slice(6, -1) ?? "15",
    concurrency: record.concurrency, catchUp: record.catch_up };
}
function scope(draft: Draft): RoutineScope {
  return draft.scopeKind === "company" ? { kind: "company", id: "surtec" } : { kind: draft.scopeKind, id: draft.scopeId };
}
function configured(draft: Draft, revision: number): RoutineConfigureInput {
  return { expected_revision: revision, action: draft.action, scope: scope(draft), enabled: draft.enabled,
    schedule: draft.schedule === "manual" ? null : `every:${draft.minutes}m`, concurrency: draft.concurrency, catch_up: draft.catchUp };
}
function utc(value: string | null): string { return value === null ? "No disponible" : `${value} (UTC)`; }
function bindingKey(detail: RoutineDetail): string { return JSON.stringify({ routine: detail.routine, execution: detail.execution }); }

function OccurrenceEvidence({ occurrence }: { occurrence: RoutineOccurrenceSummary | null }) {
  if (!occurrence) return <p className="work-issue-note">Sin ejecución registrada; no se infiere evidencia fresca.</p>;
  const receipt = occurrence.receipt;
  return <dl className="detail-dl routine-panel-facts">
    <dt>Estado de ejecución</dt><dd>{STATUS_LABELS[occurrence.status]} · {occurrence.status}</dd>
    <dt>Última ejecución</dt><dd>{safe(occurrence.id)} · r{occurrence.routine_revision}</dd>
    <dt>Slot registrado</dt><dd>{utc(occurrence.slot)}</dd>
    <dt>Inicio / fin</dt><dd>{utc(occurrence.started_at)} / {utc(occurrence.finished_at)}</dd>
    <dt>Frescura registrada</dt><dd>{receipt ? FRESHNESS_LABELS[receipt.freshness] : "Sin receipt; no disponible"}</dd>
    <dt>Evidencia capturada</dt><dd>{receipt ? utc(receipt.captured_at) : "No disponible"}</dd>
    <dt>Fallo exacto</dt><dd>{receipt?.failure_code ?? "Sin fallo registrado; no implica éxito sin receipt"}</dd>
    <dt>Próxima acción</dt><dd>{receipt ? NEXT_ACTIONS[receipt.next_action] : "Inspeccionar evidencia; no repetir automáticamente"}</dd>
    {receipt && <><dt>Contadores del receipt</dt><dd>{receipt.counts.projects_selected} proyectos · {receipt.counts.facts_total} hechos · {receipt.counts.facts_fresh} frescos · {receipt.counts.facts_unavailable} no disponibles · {receipt.counts.signals_evaluated} señales · {receipt.counts.proposals_created} propuestas · {receipt.counts.reports_written} informes</dd>
      <dt>Consumo determinístico</dt><dd>{receipt.consumption.attempts ?? "desconocido"} intento · {receipt.consumption.runtime_ms ?? "desconocido"} ms · {receipt.consumption.runtime_state} · 0 llamadas a modelos · 0 tokens · 0 escrituras de workspace</dd>
      <dt>Presupuesto del receipt</dt><dd>{receipt.budget_outcome}</dd></>}
  </dl>;
}

export function RoutinePanel({ projects = [], refreshKey }: { projects?: ProjectView[]; refreshKey?: string | number }) {
  const [list, setList] = useState<RoutineList | null>(null);
  const [detail, setDetail] = useState<RoutineDetail | null>(null);
  const [objectives, setObjectives] = useState<Array<Pick<Objective, "id" | "title">>>([]);
  const [organizationUnavailable, setOrganizationUnavailable] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [listPending, setListPending] = useState(true);
  const [detailPending, setDetailPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsExplicitRefresh, setNeedsExplicitRefresh] = useState(false);
  const [error, setError] = useState<{ source: "list" | "detail" | "action"; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState(0);
  const mounted = useRef(true), listSequence = useRef(0), detailSequence = useRef(0), organizationSequence = useRef(0), operationSequence = useRef(0);
  const selected = useRef<string | null>(null), currentDetail = useRef<RoutineDetail | null>(null);
  const currentList = useRef<RoutineList | null>(null), currentListPending = useRef(true);
  const explicitRefresh = useRef(-1), mutationPending = useRef(false), pendingMutationSequence = useRef<number | null>(null);
  const releaseAfterRefresh = useRef(false), refreshSequence = useRef(0);
  const currentDraft = useRef(draft); currentDraft.current = draft;
  const invalidateOperation = useCallback(() => { operationSequence.current++; setConfirmation(null); setNotice(null); }, []);
  const acceptDetail = useCallback((value: RoutineDetail, preserveDraft = false) => {
    const same = currentDetail.current !== null && bindingKey(currentDetail.current) === bindingKey(value);
    currentDetail.current = value; setDetail(value);
    setConfirmation((approved) => approved && approved.bindingKey !== bindingKey(value) ? null : approved);
    if (!preserveDraft || !same) setDraft(recordDraft(value.routine));
  }, []);
  const readDetail = useCallback(async (id: string) => {
    const sequence = ++detailSequence.current; setDetailPending(true);
    try {
      const value = await fetchRoutine(id);
      if (!mounted.current || sequence !== detailSequence.current || selected.current !== id) return;
      if (!currentListPending.current && (currentList.current?.state !== "available"
        || !currentList.current.routines.some((entry) => entry.routine.id === id && recordKey(entry.routine) === recordKey(value.routine)))) {
        throw new Error("Detail differs from the current complete inventory");
      }
      acceptDetail(value, true); setError((value) => value?.source === "detail" ? null : value);
    } catch {
      if (!mounted.current || sequence !== detailSequence.current || selected.current !== id) return;
      currentDetail.current = null; setDetail(null); setDraft(initialDraft()); setConfirmation(null);
      setError((value) => value?.source === "action" ? value : { source: "detail", message: "Detalle de rutina no disponible. Actualizá antes de una nueva acción explícita." });
    } finally { if (mounted.current && sequence === detailSequence.current) setDetailPending(false); }
  }, [acceptDetail]);
  const readList = useCallback(async () => {
    const sequence = ++listSequence.current; currentListPending.current = true; setListPending(true);
    try {
      const value = await fetchRoutines();
      if (!mounted.current || sequence !== listSequence.current) return;
      currentList.current = value; currentListPending.current = false; setList(value);
      if (value.state === "unavailable") {
        detailSequence.current++; currentDetail.current = null; setDetail(null); setDetailPending(false); setDraft(initialDraft());
        setConfirmation(null); setError((error) => error?.source === "action" ? error : { source: "list", message: "Estado de rutinas no disponible; no se repara ni se inicia trabajo desde esta vista." });
      } else if (selected.current && !value.routines.some((entry) => entry.routine.id === selected.current)) {
        detailSequence.current++; currentDetail.current = null; setDetail(null); setDetailPending(false); setDraft(initialDraft()); setConfirmation(null);
        setError((error) => error?.source === "action" ? error : { source: "list", message: "Rutina seleccionada ausente del inventario actual; inspeccioná el estado antes de una nueva acción. No se crea una sustituta." });
      } else if (selected.current && currentDetail.current
        && recordKey(value.routines.find((entry) => entry.routine.id === selected.current)!.routine) !== recordKey(currentDetail.current.routine)) {
        detailSequence.current++; currentDetail.current = null; setDetail(null); setDraft(initialDraft()); setConfirmation(null);
        setError((error) => error?.source === "action" ? error : { source: "detail", message: "La definición cambió en el inventario; revalidando detalle antes de nuevas acciones." });
        void readDetail(selected.current);
      } else setError((value) => value?.source === "list" ? null : value);
    } catch {
      if (!mounted.current || sequence !== listSequence.current) return;
      currentList.current = null; setList(null); detailSequence.current++; currentDetail.current = null; setDetail(null); setDetailPending(false); setDraft(initialDraft()); setConfirmation(null);
      setError((error) => error?.source === "action" ? error : { source: "list", message: "Lectura de rutinas no disponible. El resto de Today conserva su estado independiente." });
    } finally { if (mounted.current && sequence === listSequence.current) { currentListPending.current = false; setListPending(false); } }
  }, [readDetail]);
  const readObjectives = useCallback(async () => {
    const sequence = ++organizationSequence.current;
    try {
      const organization = await getOrganization();
      if (!mounted.current || sequence !== organizationSequence.current) return;
      if (!Array.isArray(organization.objectives) || organization.objectives.length > 10000
        || organization.objectives.some((entry) => !entry || entry.schema_version !== 1 || entry.company_id !== "surtec"
          || !safeId(entry.id) || typeof entry.title !== "string")
        || new Set(organization.objectives.map((entry) => entry.id)).size !== organization.objectives.length) throw new Error("Unsupported objective choices");
      setObjectives(organization.objectives.map((entry) => ({ id: entry.id, title: entry.title }))); setOrganizationUnavailable(false);
    } catch {
      if (mounted.current && sequence === organizationSequence.current) { setObjectives([]); setOrganizationUnavailable(true); }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; listSequence.current++; detailSequence.current++; organizationSequence.current++; operationSequence.current++; };
  }, []);
  useEffect(() => {
    const sequence = ++refreshSequence.current;
    const explicit = explicitRefresh.current !== reload; explicitRefresh.current = reload;
    // Passive Today polling revalidates the exact binding without erasing an
    // unchanged human review. It never races an already submitted mutation.
    if (!explicit && mutationPending.current) return;
    if (explicit) { invalidateOperation(); setError(null); }
    const requestedRelease = explicit && releaseAfterRefresh.current, expectedSelection = selected.current;
    if (explicit) releaseAfterRefresh.current = false;
    void Promise.all([readList(), readObjectives(), expectedSelection ? readDetail(expectedSelection) : Promise.resolve()]).then(() => {
      if (!requestedRelease || !mounted.current || sequence !== refreshSequence.current || mutationPending.current
        || selected.current !== expectedSelection || currentListPending.current || !currentList.current
        || currentList.current.state === "unavailable") return;
      if (expectedSelection && (!currentDetail.current || !currentList.current.routines.some((entry) => entry.routine.id === expectedSelection
        && recordKey(entry.routine) === recordKey(currentDetail.current!.routine)))) return;
      setNeedsExplicitRefresh(false);
    });
  }, [refreshKey, reload, invalidateOperation, readList, readObjectives, readDetail]);

  const changeSelection = (id: string | null) => {
    invalidateOperation(); detailSequence.current++; selected.current = id; setSelectedId(id); currentDetail.current = null;
    setDetail(null); setDraft(initialDraft()); setError(null); setDetailPending(false);
    if (id) void readDetail(id);
  };
  const edit = (patch: Partial<Draft>) => { invalidateOperation(); setDraft((value) => ({ ...value, ...patch })); };
  const rawProjectIds = Array.isArray(projects) ? projects.map((project) => {
    try { const descriptor = project && Object.getOwnPropertyDescriptor(project, "id"); return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined; }
    catch { return undefined; }
  }) : [];
  const projectIds = [...new Set(rawProjectIds.filter(safeId))];
  const projectChoicesUnavailable = !Array.isArray(projects) || rawProjectIds.length !== projectIds.length;
  const knownScope = draft.scopeKind === "company" || (draft.scopeKind === "project" ? projectIds.includes(draft.scopeId)
    : objectives.some((objective) => objective.id === draft.scopeId));
  const validInterval = draft.schedule === "manual" || /^(?:[1-9][0-9]{0,4})$/.test(draft.minutes)
    && Number(draft.minutes) >= 15 && Number(draft.minutes) <= 10080;
  const readable = list !== null && list.state !== "unavailable" && !listPending;
  const current = detail !== null && detail.routine.id === selectedId && !detailPending
    && list !== null && list.routines.some((entry) => entry.routine.id === selectedId && recordKey(entry.routine) === recordKey(detail.routine));
  const editable = readable && !busy && !needsExplicitRefresh && (selectedId === null || current);
  const dirty = detail !== null && JSON.stringify(configured(draft, detail.routine.revision)) !== JSON.stringify(configured(recordDraft(detail.routine), detail.routine.revision));
  const canRun = editable && current && detail.routine.enabled && detail.execution.state === "fixture-enabled"
    && !dirty && !["reserved", "running", "needs-review"].includes(detail.last_occurrence?.status ?? "");
  const review = (operation: Operation) => {
    if (mutationPending.current || !editable || operation === "ejecución" && !canRun || operation !== "deshabilitación" && (!knownScope || !validInterval)) return;
    setConfirmation({ operation, id: selectedId, revision: detail?.routine.revision ?? null, draftKey: JSON.stringify(draft), bindingKey: detail ? bindingKey(detail) : null });
  };
  const confirm = async () => {
    const approved = confirmation;
    if (mutationPending.current || !approved || !editable || approved.id !== selected.current || approved.revision !== (currentDetail.current?.routine.revision ?? null)
      || approved.bindingKey !== (currentDetail.current ? bindingKey(currentDetail.current) : null)
      || approved.draftKey !== JSON.stringify(currentDraft.current) || approved.operation === "ejecución" && !canRun
      || approved.operation !== "deshabilitación" && (!knownScope || !validInterval)) { setConfirmation(null); return; }
    const sequence = ++operationSequence.current; mutationPending.current = true; pendingMutationSequence.current = sequence;
    setConfirmation(null); setBusy(true); setError(null); setNotice(null);
    try {
      if (approved.operation === "creación") {
        const value = await createRoutine({ action: draft.action, scope: scope(draft) });
        if (!mounted.current || sequence !== operationSequence.current) return;
        selected.current = value.routine.id; setSelectedId(value.routine.id); acceptDetail(value);
        setNotice("Rutina creada deshabilitada y manual. Configurar es una confirmación independiente.");
      } else if (approved.id && approved.revision !== null) {
        if (approved.operation === "ejecución") {
          const value = await runRoutine(approved.id, approved.revision);
          if (!mounted.current || sequence !== operationSequence.current || selected.current !== approved.id) return;
          setNotice(`${value.status === "existing" ? "Ocurrencia existente; no se repite" : "Solicitud admitida por el servidor"}: ${safe(value.occurrence.id)}. No implica finalización ni evidencia fresca.`);
          void readDetail(approved.id);
        } else {
          const value = approved.operation === "configuración" ? await configureRoutine(approved.id, configured(draft, approved.revision))
            : await disableRoutine(approved.id, approved.revision);
          if (!mounted.current || sequence !== operationSequence.current || selected.current !== approved.id) return;
          acceptDetail(value); setNotice(approved.operation === "configuración" ? "Configuración guardada en una nueva revisión; no concede ejecución." : "Rutina deshabilitada; historial y contabilidad preservados.");
        }
      }
      if (mounted.current && sequence === operationSequence.current) void readList();
    } catch {
      if (!mounted.current || sequence !== operationSequence.current) return;
      detailSequence.current++; currentDetail.current = null; setDetail(null); setDetailPending(false); setDraft(initialDraft()); setConfirmation(null);
      setNeedsExplicitRefresh(true);
      setError({ source: "action", message: "Acción no confirmada. La persistencia pudo ocurrir aunque fallara la respuesta; la revisión, sesión o política pudo cambiar. Actualizá e inspeccioná el estado antes de una nueva confirmación. No hubo reintento automático." });
    } finally {
      // Selection/refresh can discard a result, never unlock a still-owned
      // in-flight request and permit a second mutation before it settles.
      if (pendingMutationSequence.current === sequence) {
        pendingMutationSequence.current = null; mutationPending.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  };
  const totalPages = Math.max(1, Math.ceil((list?.routines.length ?? 0) / DISPLAY_LIMIT)), currentPage = Math.min(page, totalPages - 1);
  const routines = list?.routines.slice(currentPage * DISPLAY_LIMIT, (currentPage + 1) * DISPLAY_LIMIT) ?? [];
  const selectedOutside = selectedId && !routines.some((entry) => entry.routine.id === selectedId);
  return <section className="panel routine-panel" aria-label="Rutinas locales">
    <div className="section-head routine-panel-heading"><h2>Rutinas locales</h2><button type="button" className="ibtn" onClick={() => { releaseAfterRefresh.current = true; setReload((value) => value + 1); }}>Actualizar rutinas</button></div>
    <p className="work-issue-note">Acciones determinísticas, sin modelos, escritura de workspace ni publicación. Los receipts son evidencia histórica, no salud del API/worker ni permiso de ejecución. Sin host disponible no hay trabajo offline.</p>
    {listPending && <p role="status">Leyendo rutinas…</p>}
    {list?.state === "absent" && <p className="work-issue-note">Sin documento de rutinas; crear requiere confirmación explícita.</p>}
    {error && <p role="alert" className="routine-panel-error">{error.message}</p>}
    {needsExplicitRefresh && <p className="routine-panel-warning">Acciones bloqueadas hasta «Actualizar rutinas» y validar el inventario/detalle. El polling, cambiar selección o preparar una nueva rutina no repite ni desbloquea una solicitud ambigua.</p>}
    {notice && <p role="status">{notice}</p>}
    {organizationUnavailable && <p className="work-issue-note">Objetivos no disponibles. El alcance compañía/proyecto no se convierte en una caída global; el servidor revalida la selección.</p>}
    {projectChoicesUnavailable && <p className="work-issue-note">Inventario de proyectos parcialmente no disponible; solo se ofrecen IDs existentes válidos, sin sustituciones.</p>}
    {routines.length > 0 && <section className="routine-panel-overview" aria-label="Resumen de rutinas"><h3>Actividad registrada de rutinas</h3>
      {listPending && <p className="work-issue-note">Revalidando listado; los registros previos no demuestran vigencia actual.</p>}
      {routines.map((entry) => <article key={entry.routine.id}><h4>{safe(entry.routine.id)} · r{entry.routine.revision}</h4><p>{ACTION_LABELS[entry.routine.action]} · {entry.routine.enabled ? "Habilitada" : "Deshabilitada"} · {safe(entry.routine.scope.id)}</p>
        <dl className="detail-dl routine-panel-facts"><dt>Último estado registrado</dt><dd>{entry.last_occurrence ? `${STATUS_LABELS[entry.last_occurrence.status]} · ${entry.last_occurrence.status}` : "Sin ejecución registrada"}</dd>
          <dt>Última captura</dt><dd>{entry.last_occurrence?.receipt ? utc(entry.last_occurrence.receipt.captured_at) : "Sin receipt; no disponible"}</dd>
          <dt>Frescura del último receipt</dt><dd>{entry.last_occurrence?.receipt ? FRESHNESS_LABELS[entry.last_occurrence.receipt.freshness] : "No disponible"}</dd>
          <dt>Fallo del último receipt</dt><dd>{entry.last_occurrence?.receipt?.failure_code ?? "Sin fallo registrado; no implica éxito"}</dd>
          <dt>Siguiente slot teórico</dt><dd>{entry.next_slot ? utc(entry.next_slot) : "Sin próximo slot automático"}</dd></dl>
      </article>)}<p className="work-issue-note">Slots y frescura son registros históricos/informativos; no garantizan ejecución offline ni salud del API/worker.</p></section>}
    <div className="routine-panel-toolbar"><label>Seleccionar rutina<select aria-label="Seleccionar rutina" value={selectedId ?? ""} onChange={(event) => changeSelection(event.target.value || null)}>
      <option value="">Nueva rutina</option>{routines.map((entry) => <option key={entry.routine.id} value={entry.routine.id}>{safe(entry.routine.id)} · r{entry.routine.revision}</option>)}
      {selectedOutside && <option value={selectedId}>{safe(selectedId)}{detail ? ` · r${detail.routine.revision}` : " · detalle no disponible"}</option>}
    </select></label><button type="button" className="ibtn" onClick={() => changeSelection(null)}>Nueva rutina</button></div>
    {list && list.routines.length > DISPLAY_LIMIT && <div className="routine-panel-actions"><p className="work-issue-note">Rutinas {currentPage * DISPLAY_LIMIT + 1}–{Math.min((currentPage + 1) * DISPLAY_LIMIT, list.routines.length)} de {list.routines.length}; hasta {DISPLAY_LIMIT} por página, sin inferir ausencia.</p><button type="button" className="ibtn" disabled={currentPage === 0 || listPending} onClick={() => setPage(currentPage - 1)}>Rutinas anteriores</button><button type="button" className="ibtn" disabled={currentPage >= totalPages - 1 || listPending} onClick={() => setPage(currentPage + 1)}>Rutinas siguientes</button></div>}
    {detailPending && <p role="status">Leyendo detalle actual…</p>}
    {(selectedId === null || detail) && <div className="routine-panel-form">
      <label>Acción de rutina<select aria-label="Acción de rutina" value={draft.action} disabled={!editable} onChange={(event) => edit({ action: event.target.value as RoutineAction })}>{Object.entries(ACTION_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>Alcance de rutina<select aria-label="Alcance de rutina" value={draft.scopeKind} disabled={!editable} onChange={(event) => edit({ scopeKind: event.target.value as RoutineScope["kind"], scopeId: event.target.value === "company" ? "surtec" : "" })}><option value="company">Compañía SURTEC</option><option value="project">Proyecto existente</option><option value="objective">Objetivo existente</option></select></label>
      {draft.scopeKind === "project" && <label>Proyecto de rutina<select aria-label="Proyecto de rutina" value={draft.scopeId} disabled={!editable} onChange={(event) => edit({ scopeId: event.target.value })}><option value="">Seleccionar proyecto</option>{projectIds.map((id) => <option key={id} value={id}>{safe(id)}</option>)}</select></label>}
      {draft.scopeKind === "objective" && <label>Objetivo de rutina<select aria-label="Objetivo de rutina" value={draft.scopeId} disabled={!editable} onChange={(event) => edit({ scopeId: event.target.value })}><option value="">Seleccionar objetivo</option>{objectives.map((objective) => <option key={objective.id} value={objective.id}>{safe(objective.title)} · {safe(objective.id)}</option>)}</select></label>}
      {detail && <><label className="routine-panel-checkbox"><input aria-label="Rutina habilitada" type="checkbox" checked={draft.enabled} disabled={!editable} onChange={(event) => edit({ enabled: event.target.checked })} />Rutina habilitada</label>
        <label>Programación de rutina<select aria-label="Programación de rutina" value={draft.schedule} disabled={!editable} onChange={(event) => edit({ schedule: event.target.value as Draft["schedule"] })}><option value="manual">Manual</option><option value="interval">Intervalo UTC acotado</option></select></label>
        {draft.schedule === "interval" && <label>Intervalo en minutos<input aria-label="Intervalo en minutos" type="number" min={15} max={10080} step={1} value={draft.minutes} disabled={!editable} onChange={(event) => edit({ minutes: event.target.value })} /><small>15..10080 minutos; anclado a la revisión guardada, no cron.</small></label>}
        <label>Concurrencia de rutina<select aria-label="Concurrencia de rutina" value={draft.concurrency} disabled={!editable} onChange={(event) => edit({ concurrency: event.target.value as RoutineConcurrency })}><option value="skip">Omitir si está ocupada</option><option value="coalesce">Conservar como máximo un slot pendiente</option></select></label>
        <label>Recuperación de rutina<select aria-label="Recuperación de rutina" value={draft.catchUp} disabled={!editable} onChange={(event) => edit({ catchUp: event.target.value as RoutineCatchUp })}><option value="skip-missed">Omitir intervalos perdidos</option><option value="run-once">Como máximo una recuperación</option></select></label></>}
    </div>}
    {!knownScope && <p className="work-issue-note">Seleccioná un alcance existente; no se admite un ID libre.</p>}
    {!validInterval && <p role="alert">El intervalo debe ser un entero entre 15 y 10080 minutos.</p>}
    {detail && <><dl className="detail-dl routine-panel-facts"><dt>Rutina / revisión</dt><dd>{safe(detail.routine.id)} · r{detail.routine.revision}</dd><dt>Configuración guardada</dt><dd>{detail.routine.enabled ? "Habilitada" : "Deshabilitada"} · {detail.routine.schedule ?? "Manual"} · {detail.routine.concurrency} · {detail.routine.catch_up}</dd>
      <dt>Política</dt><dd>r{detail.routine.policy.revision} · {detail.routine.policy.fingerprint}</dd><dt>Próximo slot teórico</dt><dd>{detail.next_slot ? utc(detail.next_slot) : "Sin próximo slot automático"}; no confirma trabajo mientras el host esté detenido.</dd><dt>Historial total</dt><dd>{detail.occurrences_total} ocurrencias; no se borra al deshabilitar.</dd></dl>
      <OccurrenceEvidence occurrence={detail.last_occurrence} />
      <p className="work-issue-note">La frescura corresponde al momento de captura del receipt, no a la hora de lectura del listado. Un resultado parcial, obsoleto o ausente no se convierte en éxito por recargar.</p>
      {detail.execution.state === "inactive" ? <p className="routine-panel-warning">Ejecución productiva inactiva: pendiente T015–T017 y confirmación exacta del operador. Habilitar la configuración no activa el runtime.</p>
        : <p className="work-issue-note">Composición privada de fixture registrada; este descriptor no concede autoridad. Cada solicitud explícita se revalida en el servidor.</p>}
      {dirty && <p className="work-issue-note">Hay cambios sin guardar; confirmar configuración antes de solicitar ejecución.</p>}
      <details className="routine-panel-history"><summary>Historial acotado de ocurrencias</summary>{detail.occurrences.slice(0, 20).map((entry) => <article key={entry.id}><h3>{safe(entry.id)}</h3><OccurrenceEvidence occurrence={entry} /></article>)}
        {detail.occurrences.length === 0 && <p>Sin ocurrencias registradas.</p>}{detail.occurrences_total > detail.occurrences.length && <p>Se conservan más ocurrencias; el detalle muestra como máximo 20 y no inventa ausencia.</p>}</details>
    </>}
    <div className="routine-panel-actions">{selectedId === null ? <button type="button" className="ibtn" disabled={!editable || !knownScope} onClick={() => review("creación")}>Revisar creación</button>
      : <><button type="button" className="ibtn" disabled={!editable || !knownScope || !validInterval} onClick={() => review("configuración")}>Revisar configuración</button><button type="button" className="ibtn" disabled={!canRun} onClick={() => review("ejecución")}>Revisar ejecución</button><button type="button" className="ibtn" disabled={!editable || !detail?.routine.enabled} onClick={() => review("deshabilitación")}>Revisar deshabilitación</button></>}</div>
    {confirmation && <section className="routine-panel-confirmation" aria-label="Confirmación de rutina"><h3>Revisar {confirmation.operation}</h3><p>{confirmation.id ? `${safe(confirmation.id)} · revisión esperada ${confirmation.revision}` : "Crear una definición manual deshabilitada"}</p>
      {(confirmation.operation === "creación" || confirmation.operation === "configuración") && <p>{ACTION_LABELS[draft.action]} · {draft.scopeKind}:{safe(draft.scopeId)}{confirmation.operation === "configuración" ? ` · ${draft.enabled ? "habilitada" : "deshabilitada"} · ${draft.schedule === "manual" ? "manual" : `every:${draft.minutes}m (UTC)`} · ${draft.concurrency} · ${draft.catchUp}` : ""}</p>}
      <p>Solo esta acción y revisión. No autoriza modelos, publicación ni replay; el servidor valida nuevamente política, sesión y ownership.</p><div className="routine-panel-actions"><button type="button" className="ibtn" disabled={busy || !editable || confirmation.operation === "ejecución" && !canRun || confirmation.operation !== "deshabilitación" && (!knownScope || !validInterval)} onClick={() => void confirm()}>Confirmar {confirmation.operation}</button><button type="button" className="ibtn" onClick={() => setConfirmation(null)}>Cancelar confirmación</button></div></section>}
    {busy && <p role="status">Solicitando acción explícita…</p>}
  </section>;
}
