import { useEffect, useRef, useState } from "react";
import type { ContextManifest } from "../../../../lib/context/types";
import type { ClientContextCategory, ClientContextOptions } from "../../../../lib/client-portfolio";
import { redactText } from "../../../../lib/security/redaction";
import { previewContext, type ContextPreview as Preview, type ContextPreviewRequest } from "../api";

export const CLIENT_CONTEXT_LABELS: Record<ClientContextCategory, string> = {
  "client-identity": "Identidad del cliente",
  "project-outcome": "Objetivo y próxima acción del proyecto",
  "active-commitments": "Compromisos de entrega activos",
  "service-context": "Criticidad, SLA y próxima revisión",
  "confidential-notes": "Notas confidenciales del cliente",
};

// A secondary display guard, not a universal privacy or permission boundary.
export function contextDisplayText(text: string): string {
  return redactText(text).replace(/\b[A-Za-z]:[\\/][^\s<>"`]+/g, "[LOCAL_PATH]")
    .replace(/(^|[\s(])\/[^\s<>"`]+/g, "$1[LOCAL_PATH]");
}

export function useContextPreview(request: ContextPreviewRequest | null) {
  const key = JSON.stringify(request);
  const sequence = useRef(0);
  const [state, setState] = useState<{ key: string; pending?: boolean; preview?: Preview; error?: string } | null>(null);
  // Cleanup fences late responses, including A -> B -> A and unmount.
  useEffect(() => { sequence.current++; setState(null); return () => { sequence.current++; }; }, [key]);
  const clearPreview = () => { sequence.current++; setState(null); };
  const requestPreview = async () => {
    if (!request) return;
    const attempt = ++sequence.current;
    setState({ key, pending: true });
    try {
      const preview = await previewContext(request);
      if (preview.schema_version !== 1 || typeof preview.allowed !== "boolean" || !/^[a-f0-9]{64}$/.test(preview.fingerprint)
        || preview.manifest?.schema_version !== 1 || preview.manifest.fingerprint !== preview.fingerprint || preview.manifest.project_id !== request.project
        || preview.manifest.agent_id !== request.agent || preview.manifest.role_id !== request.role_id) {
        throw new Error("Unsupported or mismatched context preview; regenerate before dispatch");
      }
      if (attempt === sequence.current) setState({ key, preview });
    } catch (error) {
      if (attempt === sequence.current) setState({ key, error: contextDisplayText((error as Error).message) });
    }
  };
  return {
    preview: state?.key === key ? state.preview ?? null : null,
    pending: state?.key === key && state.pending === true,
    error: state?.key === key ? state.error ?? null : null,
    requestPreview, clearPreview,
  };
}

export function ClientContextConsent({ options, categories, onChange, disabled, error }: {
  options: ClientContextOptions | null; categories: ClientContextCategory[];
  onChange: (categories: ClientContextCategory[]) => void; disabled: boolean; error: string | null;
}) {
  return <>
    {options?.available && options.categories.length > 0 && <fieldset className="task-client-context">
      <legend>Contexto del cliente (opcional)</legend>
      <p>Por defecto no se comparte ningún dato del cliente. Seleccioná solo las categorías necesarias para esta tarea.</p>
      {options.categories.map((category) => <label key={category}>
        <input type="checkbox" checked={categories.includes(category)} disabled={disabled}
          onChange={(event) => onChange(event.target.checked ? [...categories, category] : categories.filter((item) => item !== category))} />
        <span>{CLIENT_CONTEXT_LABELS[category]}{category === "confidential-notes" ? " · confidencial" : ""}</span>
      </label>)}
      {categories.length > 0 && <small role="status">Se enviarán solo las categorías seleccionadas y quedará registrada su lista en la tarea.</small>}
      {categories.includes("confidential-notes") && <small role="note">Confirmaste compartir notas confidenciales con Codex para esta tarea.</small>}
    </fieldset>}
    {error && <p className="work-issue-note" role="note">No se pudo consultar el contexto del cliente. No se agrega ningún dato sin selección explícita.</p>}
  </>;
}

function EvidenceList({ items }: { items: string[] }) {
  return items.length ? <ul className="detail-list">{items.map((item, index) => <li key={index}>{contextDisplayText(item)}</li>)}</ul> : <p className="empty-mini">Ninguno.</p>;
}

export function ContextManifestEvidence({ manifest }: { manifest: ContextManifest }) {
  if (manifest.schema_version !== 1) return <p role="alert">Versión de manifiesto no soportada; no se interpreta como autorización.</p>;
  return <>
    <dl className="detail-dl">
      <dt>Perfil</dt><dd>{contextDisplayText(manifest.role_id)}</dd>
      <dt>Agente</dt><dd>{contextDisplayText(manifest.agent_id)}</dd>
      <dt>Proyecto</dt><dd>{contextDisplayText(manifest.project_id)}</dd>
      <dt>Fingerprint</dt><dd>{contextDisplayText(manifest.fingerprint)}</dd>
      <dt>Sandbox</dt><dd>{manifest.sandbox}</dd>
      <dt>Capacidades</dt><dd>{manifest.tools.join(", ")}</dd>
      <dt>Contexto</dt><dd>{manifest.total_lines} / {manifest.limits.max_lines} líneas · {manifest.total_bytes} / {manifest.limits.max_bytes} bytes · {manifest.sources.length} / {manifest.limits.max_sources} fuentes</dd>
      <dt>Presupuesto</dt><dd>{manifest.budget.max_attempts} intentos · {manifest.budget.max_runtime_ms} ms por intento · {manifest.budget.max_total_tokens} tokens máximos</dd>
      <dt>Routing</dt><dd>{manifest.routing.action} · {manifest.routing.work_scale}</dd>
      <dt>Revisión</dt><dd>{manifest.routing.review_depth} · QA {manifest.routing.qa_required ? "requerido" : "no requerido"} · mínimo {manifest.testing.minimum_review_depth}</dd>
      <dt>Testing</dt><dd>{manifest.testing.mode} · RED {manifest.testing.requires_red_evidence ? "requerido" : "no requerido"}</dd>
      <dt>Delegación</dt><dd>{manifest.routing.delegation.admitted ? "Admisible" : "No admitida"} · ejecución no disponible en Fase N</dd>
    </dl>
    <details><summary>Routing, testing y aprobaciones</summary>
      <EvidenceList items={manifest.routing.reasons} /><EvidenceList items={manifest.routing.delegation.reasons} />
      <EvidenceList items={manifest.testing.reasons} />
      <h4>Checks configurados (no ejecutados por el preview)</h4><EvidenceList items={manifest.testing.commands} />
      <h4>Aprobaciones requeridas</h4><EvidenceList items={manifest.approval_rules} />
    </details>
    <details><summary>Privacidad y fuentes excluidas</summary>
      <h4>Categorías seleccionadas</h4><EvidenceList items={manifest.selected_categories} />
      <h4>Categorías excluidas</h4><EvidenceList items={manifest.excluded_categories} />
      <h4>Fuentes omitidas</h4><EvidenceList items={manifest.omitted_sources} />
    </details>
    <details><summary>Fuentes atribuidas ({manifest.sources.length})</summary>
      <ul className="detail-list">{manifest.sources.map((source) => <li key={source.id}>
        <b>{contextDisplayText(source.id)}</b> · {source.layer} · {source.source_type} · {source.sensitivity}
        <div>{contextDisplayText(source.reason)}</div>
        <div>{source.lines} líneas · {source.bytes} bytes · revisión {contextDisplayText(source.revision)}</div>
      </li>)}</ul>
    </details>
    <p className="work-issue-note">Las fuentes seleccionadas por la aplicación están contenidas y acotadas. Las lecturas posteriores del agente no están garantizadas solo dentro del proyecto; se mantienen sandbox, red y aprobaciones. El manifiesto registra requisitos, no demuestra que los checks o la revisión hayan pasado.</p>
  </>;
}

export function ContextPreview({ preview }: { preview: Preview }) {
  return <section className="detail-card panel" aria-label="Preview de contexto">
    <h3>Preview de contexto</h3>
    <p role="status">{preview.allowed ? "Contexto habilitado para este pedido." : "Contexto bloqueado: no se puede despachar."}</p>
    {!preview.allowed && <EvidenceList items={preview.blocked_reasons} />}
    <p className="work-issue-note">Previsualizar no crea una tarea, no reserva capacidad y no ejecuta al agente. El servidor vuelve a validar al despachar; un preview vencido o cambiado requiere regeneración.</p>
    <ContextManifestEvidence manifest={preview.manifest} />
    <p className="work-issue-note">{contextDisplayText(preview.runtime_read_limitation)}</p>
  </section>;
}
