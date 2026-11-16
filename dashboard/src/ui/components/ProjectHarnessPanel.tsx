import { useEffect, useRef, useState } from "react";
import type { ProjectHarnessProfile } from "../../../../lib/harness/types";
import { getProjectHarness, type HarnessResponse } from "../api";
import { contextDisplayText as safe } from "./ContextPreview";

const PAGE_SIZE = 20;
function boundPage(page: number, total: number) { return Math.min(page, Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)); }
function PageControls({ label, total, page, onChange }: { label: string; total: number; page: number; onChange: (page: number) => void }) {
  const current = boundPage(page, total);
  if (total <= PAGE_SIZE) return null;
  return <div className="actions work-issue-actions" aria-label={`Páginas de ${label}`}>
    <span>{current * PAGE_SIZE + 1}–{Math.min((current + 1) * PAGE_SIZE, total)} de {total} registros de esta lectura</span>
    <button type="button" className="ibtn" disabled={current === 0} onClick={() => onChange(current - 1)} aria-label={`Página anterior de ${label}`}>Anterior</button>
    <button type="button" className="ibtn" disabled={(current + 1) * PAGE_SIZE >= total} onClick={() => onChange(current + 1)} aria-label={`Página siguiente de ${label}`}>Siguiente</button>
  </div>;
}

function relativeEntry(path: string): boolean {
  return path.length <= 240 && !/[\\\u0000-\u001f<>]/.test(path)
    && !path.split("/").some((part) => part === "" || part === "." || part === "..")
    && (path === "AGENTS.md" || path === ".agents" || path.startsWith(".agents/") || path.startsWith("docs/"));
}
function entryLabel(path: string): string { return relativeEntry(path) ? safe(path) : "Referencia no relativa o no admitida"; }
function matchesProject(value: HarnessResponse, projectId: string): boolean {
  return value?.observation?.schema_version === 1 && value.observation.project_id === projectId
    && (value.saved === null || value.saved?.schema_version === 1 && value.saved.project_id === projectId);
}
function ValidationFact({ profile, historical = false }: { profile: ProjectHarnessProfile; historical?: boolean }) {
  return <section aria-label={historical ? "Validación histórica guardada" : "Validación registrada de la lectura"}>
    <h3>{historical ? "Validación histórica guardada" : "Validación registrada"}</h3>
    <p>Resultado registrado: <b>{profile.validation.status}</b> · {profile.validation.observed_at
      ? <time dateTime={profile.validation.observed_at}>{profile.validation.observed_at}</time> : "sin fecha de validación registrada"}.</p>
    {historical && <p>No se transfiere este resultado al contenido de la lectura actual.</p>}
    <p className="work-issue-note">La fecha de inventario, un script presente o hashes coincidentes no prueban un done gate exitoso. Esta respuesta no expone receipt, actor ni comando ejecutado de validación; el comando registrado es solo configuración.</p>
  </section>;
}

export function ProjectHarnessPanel({ projectId }: { projectId: string }) {
  const [value, setValue] = useState<HarnessResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const [entryPage, setEntryPage] = useState(0), [findingPage, setFindingPage] = useState(0), [driftPage, setDriftPage] = useState(0);
  useEffect(() => {
    const generation = ++request.current;
    setValue(null); setError(null); setBusy(true);
    setEntryPage(0); setFindingPage(0); setDriftPage(0);
    getProjectHarness(projectId).then((next) => {
      if (generation !== request.current) return;
      if (!matchesProject(next, projectId)) throw new Error("Unconfirmed Harness binding");
      setValue(next);
    })
      .catch(() => { if (generation === request.current) setError("No pude leer el Harness. No se modificó el proyecto."); })
      .finally(() => { if (generation === request.current) setBusy(false); });
    return () => { request.current++; };
  }, [projectId]);
  async function refresh() {
    if (busy) return;
    const generation = ++request.current;
    setBusy(true); setError(null);
    try {
      const next = await getProjectHarness(projectId, true);
      if (generation !== request.current) return;
      if (!matchesProject(next, projectId)) throw new Error("Unconfirmed Harness binding");
      setValue(next); setEntryPage(0); setFindingPage(0); setDriftPage(0);
    }
    catch { if (generation === request.current) setError("No pude guardar la observación. Se conserva la última lectura; no se modificó el proyecto."); }
    finally { if (generation === request.current) setBusy(false); }
  }
  const profile = value?.observation.project_id === projectId ? value.observation : null;
  const saved = profile ? value!.saved : null;
  const sameProject = !!saved && saved.project_fingerprint === profile?.project_fingerprint;
  const sourceKnown = !!saved?.source_fingerprint && !!profile?.source_fingerprint;
  const sameSource = sourceKnown && saved!.source_fingerprint === profile?.source_fingerprint;
  const entries = profile?.entries.slice(boundPage(entryPage, profile.entries.length) * PAGE_SIZE, (boundPage(entryPage, profile.entries.length) + 1) * PAGE_SIZE) ?? [];
  const findings = profile?.findings.slice(boundPage(findingPage, profile.findings.length) * PAGE_SIZE, (boundPage(findingPage, profile.findings.length) + 1) * PAGE_SIZE) ?? [];
  const drift = profile?.drift_summary.slice(boundPage(driftPage, profile.drift_summary.length) * PAGE_SIZE, (boundPage(driftPage, profile.drift_summary.length) + 1) * PAGE_SIZE) ?? [];
  return <section id={`project-harness-${projectId}`} tabIndex={-1} className="project-detail-section panel" aria-label="Harness del proyecto" style={{ overflowWrap: "anywhere", minWidth: 0 }}>
    <div className="section-head" style={{ flexWrap: "wrap", gap: 12 }}><div><h2>Harness · inventario y Doctor</h2><p>Lectura local de inventario existente. No ejecuta instrucciones ni instala o repara archivos.</p></div>
      <button className="ibtn" type="button" style={{ maxWidth: "100%", whiteSpace: "normal" }} disabled={busy} onClick={() => void refresh()}>{busy ? "Leyendo…" : "Actualizar Harness"}</button></div>
    <p className="work-issue-note">«Actualizar Harness» inspecciona y guarda explícitamente una observación en el Control Plane; no ejecuta el runner ni modifica el proyecto. Abrir el preview no vuelve a consultar ni guardar.</p>
    {error && <p role="alert">{error}</p>}
    {!profile && !error && <p role="status">Leyendo Harness…</p>}
    {profile && <>
      <section aria-label="Fuente y frescura del Harness">
      <h3>Fuente y observación</h3>
      <dl className="project-integration__facts">
        <div><dt>Estado</dt><dd data-testid="harness-status">{profile.status}</dd></div>
        <div><dt>Doctor</dt><dd>{profile.doctor_status}</dd></div>
        <div><dt>Versión observada / canónica</dt><dd>{profile.detected_version ?? "Sin evidencia"} / {profile.canonical_version ?? "Sin fuente confiable"}</dd></div>
        <div><dt>Identidad de la fuente configurada</dt><dd>No expuesta por este contrato; no se deduce de la versión detectada.</dd></div>
        <div><dt>Fingerprint de fuente</dt><dd>{profile.source_fingerprint ?? "No disponible"}</dd></div>
        <div><dt>Fingerprint de inventario</dt><dd>{profile.project_fingerprint}</dd></div>
        <div><dt>Comparación</dt><dd>{profile.comparison}</dd></div>
      </dl>
      <p>Observado: <time dateTime={profile.observed_at}>{profile.observed_at}</time></p>
      <p data-testid="harness-saved">{saved ? <>Última observación guardada: <time dateTime={saved.observed_at}>{saved.observed_at}</time></> : "Todavía no hay una observación guardada."}</p>
      {saved && (!sameProject || sourceKnown && !sameSource) && <p>La lectura actual difiere de la observación guardada. Actualizá para guardar esta evidencia.</p>}
      {saved && <p>Huellas respecto al guardado: inventario {sameProject ? "coincidente" : "diferente"} · fuente {sourceKnown ? sameSource ? "coincidente" : "diferente" : "desconocida"}. Coincidencia no significa vigencia ni ownership.</p>}
      <p className="work-issue-note">Frescura: fechas de evidencia, no del render. El contrato no declara un plazo de caducidad; no se infiere vigencia por edad ni al recargar. El inventario es acotado, no un escaneo completo de todo el proyecto.</p>
      </section>
      <section aria-label="Testing y validación del Harness">
      <h3>Requisitos y validación registrada</h3>
      <dl className="project-integration__facts">
        <div><dt>Pruebas / runner registrado</dt><dd>{profile.testing_policy.mode} / {profile.testing_policy.runner_id ?? "Sin runner registrado"}</dd></div>
        <div><dt>Comando registrado (no ejecutado)</dt><dd>{profile.runner_command ? safe(profile.runner_command) : "Sin comando registrado"}</dd></div>
        <div><dt>RED / tipos aplicables registrados</dt><dd>{profile.testing_policy.requires_red_evidence ? "RED requerido" : "RED no requerido"} · {profile.testing_policy.applicable_task_kinds.join(", ") || "Sin tipos declarados"}</dd></div>
        <div><dt>Revisión</dt><dd>{profile.review_policy}</dd></div>
        <div><dt>Backup / rollback confirmados</dt><dd>{profile.backup_ready ? "Sí" : "Sin evidencia"} / {profile.rollback_ready ? "Sí" : "Sin evidencia"}</dd></div>
      </dl>
      <ValidationFact profile={profile} />
      {saved && <ValidationFact profile={saved} historical />}
      <p className="work-issue-note">Las declaraciones de backup/rollback no activan la continuidad diferida de P. Esta vista no autoriza ejecución, reparación, sobrescritura ni repinning de fuentes.</p>
      </section>
      <details><summary>Capacidades y archivos</summary>
        <section aria-label="Capacidades y routing del Harness"><h3>Cobertura y routing registrados</h3>
          <ul>{profile.capability_results.map((entry) => <li key={entry.capability}>{entry.capability}: {entry.status}{!entry.expected && " · no requerido por esta referencia"} · referencias: {entry.evidence.map(safe).join(", ") || "sin evidencia"}</li>)}</ul>
          <p>No se exponen rutas de tareas parseadas. Una capacidad presente no significa validación, activación ni permiso.</p>
        </section>
        <section aria-label="Entradas y ownership del Harness"><h3>Entradas relativas y ownership</h3>
          <p>La clasificación y su evidencia son datos registrados; incluso scaffold-managed no autoriza sobrescribir. Se preservan las entradas user-owned, project-owned y desconocidas.</p>
          <ul>{entries.map((entry) => <li key={entry.path}>{entryLabel(entry.path)} · {entry.status} · {entry.ownership}{entry.ownership_evidence ? ` · ${safe(entry.ownership_evidence)}` : " · sin autorización de sobrescritura"}</li>)}</ul>
          <PageControls label="entradas del Harness" total={profile.entries.length} page={entryPage} onChange={setEntryPage} />
        </section>
      </details>
      <details open={profile.findings.some((entry) => entry.severity !== "info")}><summary>Doctor y drift ({profile.findings.length})</summary>
        <section aria-label="Hallazgos registrados del Doctor">
          {findings.length === 0 && <p>Sin hallazgos en esta lectura; no demuestra un done gate ni cobertura completa.</p>}
          {findings.map((entry) => <article key={entry.id}><h3>{safe(entry.observed)}</h3><p>{entry.severity} · {entry.id}</p><p>{safe(entry.why)}</p><p>Evidencia: {entry.evidence.map(safe).join(", ")}</p><p>Siguiente paso propuesto: {safe(entry.recommended_action)}</p></article>)}
          <PageControls label="hallazgos del Doctor" total={profile.findings.length} page={findingPage} onChange={setFindingPage} />
        </section>
        <section aria-label="Drift registrado del Harness"><h3>Comparación de contenido</h3>
          {drift.length ? <ul>{drift.map((entry, index) => <li key={index}>{safe(entry)}</li>)}</ul> : <p>Sin diferencias de contenido enumeradas. Si la comparación es unknown, no se infiere compatibilidad.</p>}
          <PageControls label="drift del Harness" total={profile.drift_summary.length} page={driftPage} onChange={setDriftPage} />
        </section>
      </details>
      <details key={`${projectId}:${profile.observed_at}:${profile.project_fingerprint}:${profile.source_fingerprint}`}><summary>Ver preview de remediación (solo lectura)</summary>
        <section aria-label="Preview de remediación del Harness"><h3>Propuesta de revisión manual</h3>
          <p>No se aplicó ningún cambio. Este preview usa exclusivamente la lectura mostrada: no inspecciona, consulta, guarda ni ejecuta comandos.</p>
          <p>Antes de cualquier reparación futura: revisar cada hallazgo, confirmar ownership y scope, preservar cambios del proyecto y obtener aprobación separada. No se repinea una fuente para convertir drift en éxito.</p>
          {findings.length === 0 && <p>No hay propuestas derivables de los hallazgos disponibles; no se inventa una reparación.</p>}
          {findings.map((finding) => {
            const affected = profile.entries.filter((entry) => relativeEntry(entry.path) && finding.evidence.includes(entry.path));
            const unresolved = finding.evidence.filter((reference) => !affected.some((entry) => entry.path === reference));
            return <article key={finding.id}><h4>{safe(finding.observed)}</h4><p>Hallazgo {finding.id} · {finding.severity}</p>
              <p>Revisión manual propuesta: {safe(finding.recommended_action)}</p>
              {affected.length > 0 ? <ul>{affected.map((entry) => <li key={entry.path}>{entryLabel(entry.path)} · {entry.status} · ownership {entry.ownership} · {entry.ownership_evidence ? safe(entry.ownership_evidence) : "sin evidencia de ownership"} · sin permiso de sobrescritura</li>)}</ul>
                : <p>Entradas afectadas no confirmadas: ninguna referencia coincide exactamente con una entrada relativa de este inventario.</p>}
              {unresolved.length > 0 && <p>Referencias sin entrada exacta: {unresolved.map(safe).join(", ")}. No se resuelven ni abren desde el preview.</p>}
              <p>{finding.safely_automatable ? "La fuente marca automatización posible, pero este dato no concede autoridad ni habilita ejecución." : "Requiere revisión humana; no hay reparación automática."}</p>
            </article>;
          })}
          <PageControls label="preview de remediación" total={profile.findings.length} page={findingPage} onChange={setFindingPage} />
        </section>
      </details>
    </>}
  </section>;
}
