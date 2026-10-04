import { useEffect, useState } from "react";
import { getProjectHarness, type HarnessResponse } from "../api";

export function ProjectHarnessPanel({ projectId }: { projectId: string }) {
  const [value, setValue] = useState<HarnessResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setValue(null); setError(null); setBusy(true);
    getProjectHarness(projectId).then((next) => { if (active) setValue(next); })
      .catch(() => { if (active) setError("No pude leer el Harness. No se modificó el proyecto."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [projectId]);
  async function refresh() {
    setBusy(true); setError(null);
    try { setValue(await getProjectHarness(projectId, true)); }
    catch { setError("No pude guardar la observación. Se conserva la última lectura; no se modificó el proyecto."); }
    finally { setBusy(false); }
  }
  const profile = value?.observation;
  return <section className="project-detail-section panel" aria-label="Harness del proyecto">
    <div className="section-head"><div><h2>Harness · inventario y Doctor</h2><p>Inspección de solo lectura. No instala ni repara archivos.</p></div>
      <button className="ibtn" type="button" disabled={busy} onClick={() => void refresh()}>{busy ? "Leyendo…" : "Actualizar Harness"}</button></div>
    {error && <p role="alert">{error}</p>}
    {!profile && !error && <p role="status">Leyendo Harness…</p>}
    {profile && <>
      <dl className="project-integration__facts">
        <div><dt>Estado</dt><dd data-testid="harness-status">{profile.status}</dd></div>
        <div><dt>Doctor</dt><dd>{profile.doctor_status}</dd></div>
        <div><dt>Versión observada / canónica</dt><dd>{profile.detected_version ?? "Sin evidencia"} / {profile.canonical_version ?? "Sin fuente confiable"}</dd></div>
        <div><dt>Comparación</dt><dd>{profile.comparison}</dd></div>
        <div><dt>Pruebas / runner registrado</dt><dd>{profile.testing_policy.mode} / {profile.testing_policy.runner_id ?? "Sin runner registrado"}</dd></div>
        <div><dt>Comando registrado (no ejecutado)</dt><dd style={{ overflowWrap: "anywhere" }}>{profile.runner_command ?? "Sin comando registrado"}</dd></div>
        <div><dt>Validación registrada</dt><dd>{profile.validation.status}</dd></div>
        <div><dt>Revisión</dt><dd>{profile.review_policy}</dd></div>
        <div><dt>Backup / rollback confirmados</dt><dd>{profile.backup_ready ? "Sí" : "Sin evidencia"} / {profile.rollback_ready ? "Sí" : "Sin evidencia"}</dd></div>
      </dl>
      <p>Observado: <time>{profile.observed_at}</time></p>
      <p data-testid="harness-saved">{value?.saved ? `Última observación guardada: ${value.saved.observed_at}` : "Todavía no hay una observación guardada."}</p>
      {value?.saved && (value.saved.project_fingerprint !== profile.project_fingerprint || value.saved.source_fingerprint !== profile.source_fingerprint) && <p>La lectura actual difiere de la observación guardada. Actualizá para guardar esta evidencia.</p>}
      <details><summary>Capacidades y archivos</summary>
        <ul>{profile.capability_results.map((entry) => <li key={entry.capability}>{entry.capability}: {entry.status}{!entry.expected && " · no requerido por esta referencia"}</li>)}</ul>
        <ul>{profile.entries.map((entry) => <li key={entry.path} style={{ overflowWrap: "anywhere" }}>{entry.path} · {entry.status} · {entry.ownership}{entry.ownership_evidence ? ` · ${entry.ownership_evidence}` : " · sin autorización de sobrescritura"}</li>)}</ul>
      </details>
      <details open={profile.findings.some((entry) => entry.severity !== "info")}><summary>Doctor y drift ({profile.findings.length})</summary>
        {profile.findings.map((entry) => <article key={entry.id}><h3>{entry.observed}</h3><p>{entry.why}</p><p style={{ overflowWrap: "anywhere" }}>Evidencia: {entry.evidence.join(", ")}</p><p>Siguiente paso: {entry.recommended_action}</p></article>)}
      </details>
    </>}
  </section>;
}
