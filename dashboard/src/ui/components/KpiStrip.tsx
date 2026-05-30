import { FolderGit2, Loader, BellRing, GitCommitHorizontal, type LucideIcon } from "lucide-react";
import type { Kpis, Kpi } from "../derive-kpis";

function KpiCard({ label, kpi, Icon }: { label: string; kpi: Kpi; Icon: LucideIcon }) {
  return (
    <div className="kpi">
      <span className="b-label">{label}</span>
      <span className={`num${kpi.emphasis ? ` ${kpi.emphasis}` : ""}`}>{kpi.value}</span>
      <span className="foot">{kpi.foot}</span>
      <span className="spark"><Icon /></span>
    </div>
  );
}

export function KpiStrip({ kpis }: { kpis: Kpis }) {
  return (
    <section className="kpis">
      <KpiCard label="Proyectos" kpi={kpis.projects} Icon={FolderGit2} />
      <KpiCard label="En curso" kpi={kpis.inProgress} Icon={Loader} />
      <KpiCard label="Atención" kpi={kpis.attention} Icon={BellRing} />
      <KpiCard label="Sin commitear" kpi={kpis.uncommitted} Icon={GitCommitHorizontal} />
    </section>
  );
}
