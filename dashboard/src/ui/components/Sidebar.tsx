export const NAV_ITEMS = ["Overview", "Procesos", "Proyectos", "Tareas", "Atención"] as const;
export type NavItem = (typeof NAV_ITEMS)[number];

export function Sidebar({ active, onSelect }: { active: NavItem; onSelect: (i: NavItem) => void }) {
  return (
    <aside className="es-side">
      <div className="es-side__brand">Surtec</div>
      <div className="es-side__group">Control plane</div>
      <nav className="es-side__nav">
        {NAV_ITEMS.map((i) => (
          <button
            key={i}
            type="button"
            className={`es-nav-item${i === active ? " es-nav-item--on" : ""}`}
            onClick={() => onSelect(i)}
          >
            {i}
          </button>
        ))}
      </nav>
      <div className="es-side__foot">
        <span className="es-side__foot-name">Marcos</span>
        <span className="es-side__foot-role">Admin</span>
      </div>
    </aside>
  );
}
