import { Fragment, useEffect, useRef, useState } from "react";
import { BUDGET_DIMENSIONS, type BudgetDimension } from "../../../../lib/budgets/types";
import type { BudgetSourceView } from "../../../../lib/budgets/policy";
import { redactText } from "../../../../lib/security/redaction";
import type { BudgetPreview } from "../../server/budget-service";
import type { BudgetReadView, PolicyBudgetSourceView } from "../../server/routine-service";
import { fetchBudgets } from "../api";

const LABELS: Record<BudgetDimension, string> = {
  attempts: "Intentos", runtime_ms: "Runtime (ms)", total_tokens: "Tokens",
  concurrent_reads: "Lecturas concurrentes", concurrent_writes: "Escrituras concurrentes",
  review_attempts: "Revisión · intentos", review_runtime_ms: "Revisión · runtime (ms)",
  review_total_tokens: "Revisión · tokens", corrections: "Correcciones",
};
const DENIALS = ["budget-exhausted", "budget-accounting-unavailable", "budget-policy-unavailable",
  "budget-reservation-insufficient", "budget-ledger-unavailable", "budget-preview-unavailable", "pricing-unavailable"];
const DISPLAY_LIMIT = 25;
const LIMITATION = "Lectura informativa: no reserva capacidad ni concede permiso de ejecución. La disponibilidad se revalida al admitir.";
type Value = BudgetPreview | BudgetReadView;
type Source = BudgetSourceView | PolicyBudgetSourceView;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every((entry) => Object.hasOwn(entry, "value"));
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function optionalCount(value: unknown) { return value === null || count(value); }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && !value.startsWith("0000") && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
function text(value: string): string {
  return redactText(value).replace(/\b[A-Za-z]:[\\/][^\s<>"`]+/g, "[LOCAL_PATH]")
    .replace(/(^|[\s(])\/[^\s<>"`]+/g, "$1[LOCAL_PATH]").slice(0, 256);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 10000 && Array.from(value).every((entry) => typeof entry === "string" && entry.length <= 1024);
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)
    && !value.includes("..") && !["constructor", "prototype", "__proto__"].includes(value);
}
function validAttribution(value: unknown): boolean {
  return record(value) && value.company_id === "surtec" && identifier(value.execution_id)
    && Array.isArray(value.project_ids) && value.project_ids.length <= 25 && Array.from(value.project_ids).every(identifier)
    && new Set(value.project_ids).size === value.project_ids.length
    && Array.isArray(value.objective_ids) && value.objective_ids.length <= 8 && Array.from(value.objective_ids).every(identifier)
    && new Set(value.objective_ids).size === value.objective_ids.length
    && (value.issue_id === null || identifier(value.issue_id)) && (value.role_id === null || identifier(value.role_id));
}
function validSource(value: unknown): value is Source {
  if (!record(value) || typeof value.id !== "string" || !value.id.length || value.id.length > 1024
    || !["policy", "existing"].includes(value.kind as string) || !count(value.revision) || value.revision < 1 || !hash(value.fingerprint)
    || !["none", "utc-day", "utc-month"].includes(value.period as string) || typeof value.bucket !== "string" || value.bucket.length > 32
    || !record(value.dimensions)) return false;
  if (value.scope !== undefined && (!record(value.scope) || !["company", "objective", "project", "issue", "role", "execution"].includes(value.scope.kind as string)
    || typeof value.scope.id !== "string" || !value.scope.id.length || value.scope.id.length > 160)) return false;
  return BUDGET_DIMENSIONS.every((key) => {
    const dimension = (value.dimensions as Record<string, unknown>)[key];
    return record(dimension) && ["configured", "unconfigured"].includes(dimension.status as string)
      && (dimension.status === "configured" ? count(dimension.cap) : dimension.cap === null)
      && [dimension.proven_consumed, dimension.consumed, dimension.reserved, dimension.remaining].every(optionalCount)
      && (dimension.warning === null || typeof dimension.warning === "boolean");
  });
}
function validValue(value: unknown, preview: boolean): value is Value {
  try {
    if (!record(value) || value.schema_version !== 1 || value.executable !== false || value.reserves_capacity !== false
      || !["available", "exhausted", "unavailable"].includes(value.status as string)
      || !(value.observed_at === null || timestamp(value.observed_at)) || !record(value.ledger)
      || !["absent", "available", "unavailable"].includes(value.ledger.status as string)
      || !optionalCount(value.ledger.revision) || !(value.ledger.updated_at === null || timestamp(value.ledger.updated_at))
      || !Array.isArray(value.denials) || value.denials.length > 10000 || !Array.from(value.denials).every((denial) => record(denial)
        && DENIALS.includes(denial.code as string) && strings(denial.source_ids)
        && (denial.dimension === undefined || BUDGET_DIMENSIONS.includes(denial.dimension as BudgetDimension)))) return false;
    if (!preview) return (value.policy === null || record(value.policy) && count(value.policy.revision) && value.policy.revision >= 1 && hash(value.policy.fingerprint))
      && Array.isArray(value.sources) && value.sources.length <= 10000 && Array.from(value.sources).every(validSource)
      && record(value.pricing) && value.pricing.status === "unavailable" && value.pricing.reason === "no-versioned-source";
    if (typeof value.can_admit !== "boolean" || !(value.binding === null || record(value.binding) && validAttribution(value.binding.attribution) && hash(value.binding.cap_fingerprint)
      && record(value.binding.ceilings) && BUDGET_DIMENSIONS.every((key) => count((value.binding as Record<string, Record<string, unknown>>).ceilings[key]))
      && Array.isArray(value.binding.policy_bindings) && value.binding.policy_bindings.length <= 64 && Array.from(value.binding.policy_bindings).every((binding) => {
        if (!record(binding) || typeof binding.policy_id !== "string" || binding.policy_id.length > 160 || !count(binding.policy_revision) || binding.policy_revision < 1
          || !hash(binding.policy_fingerprint) || !record(binding.limits)) return false;
        return validSource({ id: binding.policy_id, kind: "policy", revision: binding.policy_revision, fingerprint: binding.policy_fingerprint,
          scope: binding.scope, period: binding.period, bucket: binding.bucket, dimensions: Object.fromEntries(BUDGET_DIMENSIONS.map((key) => {
            const limit = (binding.limits as Record<string, unknown>)[key];
            return [key, record(limit) ? { status: limit.status, cap: limit.status === "configured" ? limit.hard_cap : null,
              proven_consumed: null, consumed: null, reserved: null, remaining: null, warning: null } : null];
          })) });
      }))) return false;
    if (value.resolution === null) return true;
    if (!record(value.resolution) || !record(value.resolution.ceilings) || !record(value.resolution.dimensions)
      || !Array.isArray(value.resolution.sources) || value.resolution.sources.length > 10000 || !Array.from(value.resolution.sources).every(validSource)) return false;
    return BUDGET_DIMENSIONS.every((key) => {
      const dimension = (value.resolution as Record<string, Record<string, unknown>>).dimensions[key];
      return count((value.resolution as Record<string, Record<string, unknown>>).ceilings[key]) && record(dimension)
        && count(dimension.ceiling) && optionalCount(dimension.remaining) && typeof dimension.warning === "boolean"
        && ["available", "exhausted", "unavailable"].includes(dimension.status as string) && strings(dimension.limiting_sources);
    });
  } catch { return false; }
}
function sourcesOf(value: Value, preview: boolean): Source[] {
  if (!preview) return (value as BudgetReadView).sources;
  const budget = value as BudgetPreview;
  if (budget.resolution) return budget.resolution.sources;
  return (budget.binding?.policy_bindings ?? []).map((binding) => ({
    id: binding.policy_id, kind: "policy", scope: binding.scope, period: binding.period, bucket: binding.bucket,
    revision: binding.policy_revision, fingerprint: binding.policy_fingerprint,
    dimensions: Object.fromEntries(BUDGET_DIMENSIONS.map((key) => [key, {
      status: binding.limits[key].status, cap: binding.limits[key].status === "configured" ? binding.limits[key].hard_cap : null,
      proven_consumed: null, consumed: null, reserved: null, remaining: null, warning: null,
    }])) as PolicyBudgetSourceView["dimensions"],
  }));
}
function inconsistentBalance(source: Source, dimension: BudgetDimension): boolean {
  const fact = source.dimensions[dimension];
  if (fact.proven_consumed !== null && fact.reserved !== null && !Number.isSafeInteger(fact.proven_consumed + fact.reserved)) return true;
  if (fact.status === "unconfigured") return fact.remaining !== null;
  if (fact.remaining !== null && fact.remaining > fact.cap!) return true;
  if (source.kind === "policy" && fact.consumed !== null && fact.proven_consumed !== null && fact.consumed !== fact.proven_consumed) return true;
  // Existing availability can be measured independently of its unavailable
  // consumption/hold breakdown. Do not reconstruct that breakdown as zeros.
  if (fact.remaining === null || fact.consumed === null || fact.reserved === null) return false;
  const total = fact.consumed + fact.reserved;
  return !Number.isSafeInteger(total) || fact.remaining !== Math.max(0, fact.cap! - total);
}

export interface BudgetSummaryProps {
  budget?: BudgetPreview | null;
  projectId?: string;
  refreshKey?: string | number;
  title?: string;
}

/** Advisory read model only. Nothing here participates in approval or dispatch. */
export function BudgetSummary({ budget, projectId, refreshKey, title = "Presupuesto de recursos" }: BudgetSummaryProps) {
  const remote = budget === undefined && identifier(projectId);
  const [epoch, setEpoch] = useState(0);
  const key = JSON.stringify([remote, projectId ?? null, refreshKey ?? null, epoch]);
  const sequence = useRef(0);
  const [state, setState] = useState<{ key: string; pending?: boolean; value?: BudgetReadView; error?: boolean } | null>(null);
  useEffect(() => {
    const generation = ++sequence.current;
    setState(remote ? { key, pending: true } : null);
    if (remote) void (async () => {
      try {
        const value = await fetchBudgets({ project_id: projectId });
        if (sequence.current === generation) setState({ key, value });
      } catch { if (sequence.current === generation) setState({ key, error: true }); }
    })();
    return () => { sequence.current++; };
  }, [key, remote, projectId]);
  const current = remote && state?.key === key ? state : null;
  const pending = remote && (!current || current.pending === true);
  const input = remote ? current?.value : budget;
  const preview = !remote;
  const parsed = validValue(input, preview) ? input : null;
  const value = parsed && preview && projectId !== undefined && (parsed as BudgetPreview).binding
    && ((parsed as BudgetPreview).binding!.attribution.project_ids.length !== 1 || (parsed as BudgetPreview).binding!.attribution.project_ids[0] !== projectId) ? null : parsed;
  const at = value?.observed_at ?? null;
  const future = Boolean(at && Date.parse(at) > Date.now() || value?.ledger.updated_at && Date.parse(value.ledger.updated_at) > Date.now());
  const accountingKnown = Boolean(value && !future && at && value.ledger.status === "available"
    && value.ledger.revision !== null && value.ledger.revision > 0 && value.ledger.updated_at && Date.parse(value.ledger.updated_at) <= Date.parse(at));
  const sources = value ? sourcesOf(value, preview) : [];
  const previewValue = value && preview ? value as BudgetPreview : null;
  const unknownDimension = (dimension: BudgetDimension) => sources.some((source) => inconsistentBalance(source, dimension)
    || source.kind === "policy" && (source.dimensions[dimension].consumed === null || source.dimensions[dimension].reserved === null)
    || source.dimensions[dimension].status === "configured" && source.dimensions[dimension].remaining === null)
    || Boolean(previewValue?.resolution && (previewValue.resolution.dimensions[dimension].status === "unavailable"
      || previewValue.resolution.dimensions[dimension].remaining === null
      || previewValue.resolution.dimensions[dimension].remaining! > previewValue.resolution.dimensions[dimension].ceiling
      || sources.some((source) => source.dimensions[dimension].status === "configured" && source.dimensions[dimension].remaining !== null
        && previewValue.resolution!.dimensions[dimension].remaining! > source.dimensions[dimension].remaining!)));
  const provenanceKnown = preview ? Boolean(previewValue?.resolution && previewValue.binding) : Boolean(value && (value as BudgetReadView).policy);
  const unavailableDenial = value?.denials.some((denial) => !["budget-exhausted", "budget-reservation-insufficient"].includes(denial.code));
  const status = !value || !accountingKnown || !provenanceKnown || unavailableDenial || BUDGET_DIMENSIONS.some(unknownDimension)
    ? "unavailable" : value.status === "available" && (value.denials.length > 0
      || BUDGET_DIMENSIONS.some((dimension) => previewValue?.resolution?.dimensions[dimension].status === "exhausted")) ? "exhausted" : value.status;
  const ceilings = previewValue?.resolution?.ceilings ?? previewValue?.binding?.ceilings;
  const denials = value?.denials ?? [];
  const amount = (number: number | null, known = accountingKnown) => known && number !== null ? String(number) : "desconocido";
  const warnings = accountingKnown ? BUDGET_DIMENSIONS.filter((key) => sources.some((source) => source.dimensions[key].warning === true)) : [];

  return <section className="detail-card panel budget-summary" aria-label={title} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
    <div className="work-issues-heading" style={{ flexWrap: "wrap" }}><h3>{title}</h3>{remote && <button className="ibtn" type="button"
      style={{ width: "fit-content", flex: "0 0 auto" }} disabled={pending} onClick={() => setEpoch((number) => number + 1)}>Actualizar presupuesto</button>}</div>
    {pending ? <p role="status">Consultando presupuesto…</p> : current?.error ? <p role="note">No pude consultar el presupuesto; el resto de la vista sigue disponible.</p>
      : !value ? <p role="status">Presupuesto no disponible.</p> : <>
        <p role="status">Disponibilidad informativa: {({ available: "disponible", exhausted: "agotada", unavailable: "no disponible" })[status]}.</p>
        {remote && <p>Alcance: proyecto {text(projectId!)} y sus políticas aplicables; no es el presupuesto exacto de un issue, rol o workflow.</p>}
        <dl className="detail-dl">
          <dt>Observado (UTC)</dt><dd>{at ? <time dateTime={at}>{at}</time> : "no disponible"}{future && " · observación futura; disponibilidad no verificable"}</dd>
          <dt>Ledger</dt><dd>{value.ledger.status} · revisión {value.ledger.revision ?? "no disponible"} · actualizado {value.ledger.updated_at ?? "no disponible"}</dd>
          {!preview && <><dt>Política</dt><dd>{(value as BudgetReadView).policy ? <>r{(value as BudgetReadView).policy!.revision} · {(value as BudgetReadView).policy!.fingerprint}</> : "no disponible"}</dd></>}
          {previewValue?.binding && <><dt>Fingerprint de caps</dt><dd>{previewValue.binding.cap_fingerprint}</dd></>}
          <dt>Moneda</dt><dd>no disponible · sin fuente de precios versionada</dd>
        </dl>
        {ceilings && <details><summary>Techos efectivos del preview</summary><dl className="detail-dl">{BUDGET_DIMENSIONS.map((dimension) => <Fragment key={dimension}>
          <dt>{LABELS[dimension]}</dt><dd>límite {ceilings[dimension]} · restante {amount(previewValue?.resolution?.dimensions[dimension].remaining ?? null, accountingKnown && !unknownDimension(dimension))}</dd>
        </Fragment>)}</dl></details>}
        {warnings.length > 0 && <p role="note">Advertencia de presupuesto: {warnings.map((key) => LABELS[key]).join(", ")}. No modifica los límites.</p>}
        {denials.length > 0 && <div><h4>Motivos de denegación</h4><ul className="detail-list">{denials.slice(0, DISPLAY_LIMIT).map((denial, index) => <li key={index}>
          {denial.code}{"dimension" in denial && denial.dimension ? ` · ${LABELS[denial.dimension]}` : ""} · fuentes: {denial.source_ids.slice(0, 8).map(text).join(", ") || "no disponibles"}
          {denial.source_ids.length > 8 && ` · ${denial.source_ids.length - 8} fuentes adicionales`}
        </li>)}</ul>{denials.length > DISPLAY_LIMIT && <p>{denials.length - DISPLAY_LIMIT} motivos adicionales; el resumen no los convierte en permiso.</p>}</div>}
        <details><summary>Fuentes y consumo ({sources.length})</summary>
          <p className="work-issue-note">Las proyecciones se superponen: no se suman consumos entre fuentes, revisión y corrección.</p>
          {sources.length === 0 && <p>Sin fuentes verificables.</p>}
          {sources.slice(0, DISPLAY_LIMIT).map((source, index) => <details key={`${source.id}:${index}`}><summary>{text(source.id)} · {source.scope ? `${source.scope.kind}: ${text(source.scope.id)}` : "restricción existente"}</summary>
            <p>Revisión {source.revision} · {source.fingerprint}</p><p>Período {source.period} · bucket {text(source.bucket)}</p>
            <dl className="detail-dl">{BUDGET_DIMENSIONS.map((dimension) => {
              const fact = source.dimensions[dimension];
              const breakdownKnown = accountingKnown && !(source.kind === "existing" && fact.consumed === null);
              const remainingKnown = accountingKnown && !inconsistentBalance(source, dimension)
                && (source.kind === "existing" || fact.consumed !== null && fact.reserved !== null);
              return <Fragment key={dimension}><dt>{LABELS[dimension]}</dt><dd>límite {fact.status === "configured" ? fact.cap : "no configurado"}
                {` · consumido ${amount(fact.consumed, breakdownKnown)} · probado ${amount(fact.proven_consumed, breakdownKnown)} · reservado ${amount(fact.reserved, breakdownKnown)} · restante ${fact.status === "unconfigured" ? "no configurado" : amount(fact.remaining, remainingKnown)}`}
                {accountingKnown && fact.warning && " · advertencia"}</dd></Fragment>;
            })}</dl>
          </details>)}
          {sources.length > DISPLAY_LIMIT && <p>{sources.length - DISPLAY_LIMIT} fuentes adicionales no desplegadas; no se omiten sus restricciones de la resolución del servidor.</p>}
        </details>
      </>}
    <p className="work-issue-note">{LIMITATION}</p>
  </section>;
}
