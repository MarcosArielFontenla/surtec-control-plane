import { useEffect, useState, type ReactNode } from "react";
import type { FeedbackMetrics } from "../../../../lib/feedback-metrics";
import { getFeedbackMetrics } from "../api";

function percent(value: number | null): string {
  return value === null ? "Sin datos" : `${Math.round(value * 100)}%`;
}

function duration(value: number | null): string {
  if (value === null) return "Sin datos";
  if (value < 60_000) return `${Math.round(value / 1000)} s`;
  if (value < 60 * 60_000) return `${(value / 60_000).toFixed(1)} min`;
  return `${(value / 3_600_000).toFixed(1)} h`;
}

function MetricCard({ title, children }: { title: string; children: ReactNode }) {
  return <section className="feedback-metric-card"><h3>{title}</h3>{children}</section>;
}

export function FeedbackMetricsView() {
  const [metrics, setMetrics] = useState<FeedbackMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    getFeedbackMetrics()
      .then((value) => { setMetrics(value); setError(null); })
      .catch(() => setError("unavailable"))
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  return (
    <>
      <div className="section-head feedback-metrics-heading">
        <div><h2>Feedback operativo</h2><p className="feedback-metrics-note">Agregados locales; sin nombres, prompts ni telemetría externa.</p></div>
        <button type="button" className="ghost-btn" onClick={refresh} disabled={loading}>{loading ? "Actualizando…" : "Actualizar"}</button>
      </div>
      {error && <div className="banner banner--warn view-note">No pude leer las métricas locales.</div>}
      {loading && !metrics ? <p className="empty-mini">Cargando métricas locales…</p> : metrics ? (
        <div className="feedback-metrics-grid">
          <MetricCard title="Recomendaciones">
            <div className="feedback-metric-value">{metrics.recommendations.actions_recorded} acciones</div>
            <p>{metrics.recommendations.accepted} aceptadas · {metrics.recommendations.snoozed} pospuestas · {metrics.recommendations.dismissed} descartadas</p>
            <p>{metrics.recommendations.pinned} fijadas · mediana evidencia→acción: {duration(metrics.recommendations.median_evidence_to_action_ms)}</p>
            <small>{metrics.recommendations.latency_samples} tiempos medibles; se conserva solo la primera acción.</small>
          </MetricCard>
          <MetricCard title="Tareas">
            <div className="feedback-metric-value">{percent(metrics.tasks.success_rate)} completadas</div>
            <p>{metrics.tasks.completed}/{metrics.tasks.terminal} tareas terminales · {percent(metrics.tasks.retry_rate)} con reintento</p>
            <p>{metrics.tasks.needs_review} requieren revisión ({percent(metrics.tasks.needs_review_rate)})</p>
          </MetricCard>
          <MetricCard title="Verificación">
            <div className="feedback-metric-value">{percent(metrics.verification.pass_rate)} aprobada</div>
            <p>{metrics.verification.passed}/{metrics.verification.eligible} verificaciones comparables</p>
            <p>{metrics.verification.failed} fallidas · {metrics.verification.skipped} omitidas · {metrics.verification.missing} sin resultado</p>
          </MetricCard>
          <MetricCard title="Sesiones de trabajo">
            <div className="feedback-metric-value">{metrics.work_sessions.completed}/{metrics.work_sessions.total} completadas</div>
            <p>{metrics.work_sessions.completed_with_next_action} cierres con próximo paso explícito</p>
            <p>{metrics.work_sessions.next_action_captured}/{metrics.work_sessions.closed} sesiones cerradas con próximo paso ({percent(metrics.work_sessions.next_action_capture_rate)})</p>
          </MetricCard>
          <MetricCard title="Vigencia de señales">
            <div className="feedback-metric-value">{metrics.signals.stale}/{metrics.signals.freshness_eligible} vencidas</div>
            <p>{percent(metrics.signals.stale_rate)} de las señales con fecha de evidencia válida superan su ventana.</p>
            <small>La demora se mide desde la evidencia, no desde la primera visualización.</small>
          </MetricCard>
        </div>
      ) : !error ? <p className="empty-mini">No hay métricas disponibles.</p> : null}
    </>
  );
}
