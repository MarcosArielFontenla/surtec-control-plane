import { CalendarDays, LayoutDashboard, Cpu, Inbox, Activity, type LucideIcon } from "lucide-react";
import { BrandMark } from "./BrandMark";
import type { Summary } from "../derive-kpis";

export const NAV_ITEMS = ["Hoy", "Overview", "Procesos", "Issues", "Actividad"] as const;
export type NavItem = (typeof NAV_ITEMS)[number];

const NAV_ICON: Record<NavItem, LucideIcon> = {
  Hoy: CalendarDays,
  Overview: LayoutDashboard,
  Procesos: Cpu,
  Issues: Inbox,
  Actividad: Activity,
};

export function Sidebar({
  active, onSelect, summary, connected,
}: { active: NavItem; onSelect: (i: NavItem) => void; summary: Summary; connected: boolean }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <BrandMark size={30} />
        <span style={{ fontFamily: "var(--font-display)", fontSize: "1.3rem", fontWeight: 800, letterSpacing: "-.02em" }}>Surtec</span>
      </div>

      <div className="nav-label">Control Plane</div>
      <nav className="nav">
        {NAV_ITEMS.map((i) => {
          const Icon = NAV_ICON[i];
          return (
            <button key={i} type="button" className={`nav-item${i === active ? " active" : ""}`} onClick={() => onSelect(i)}>
              <Icon /> {i}
            </button>
          );
        })}
      </nav>

      <div className="side-foot">
        <div className="resumen">
          <span className="b-label">Resumen</span>
          <div className="resumen-row"><span>Proyectos</span><b>{summary.total}</b></div>
          <div className="resumen-row"><span>Configurados</span><b className="ok">{summary.configured}</b></div>
          <div className="resumen-row"><span>Sin configurar</span><b className="warn">{summary.unconfigured}</b></div>
          <div className="resumen-row"><span>Necesitan atención</span><b className="warn">{summary.attention}</b></div>
          <div className="sync-note"><span className="dot" />{connected ? "En vivo · sincronizado" : "Sin conexión"}</div>
        </div>
      </div>
    </aside>
  );
}
