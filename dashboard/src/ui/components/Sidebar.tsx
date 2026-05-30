export function Sidebar() {
  const items = ["Overview", "Proyectos", "Tareas", "Atención"];
  return (
    <aside className="es-side">
      <div className="es-side__brand">Surtec</div>
      <div className="es-side__group">Control plane</div>
      <nav className="es-side__nav">
        {items.map((i, idx) => (
          <button key={i} type="button" className={`es-nav-item${idx === 0 ? " es-nav-item--on" : ""}`}>
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
