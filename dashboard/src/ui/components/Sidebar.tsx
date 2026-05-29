export function Sidebar() {
  const items = ["Overview", "Proyectos", "Tareas", "Riesgos"];
  return (
    <nav style={{ width: 160, padding: 16, borderRight: "1px solid #ddd" }}>
      <h3 style={{ marginTop: 0 }}>Surtec</h3>
      <ul style={{ listStyle: "none", padding: 0, lineHeight: 2 }}>
        {items.map((i) => <li key={i}>▸ {i}</li>)}
      </ul>
    </nav>
  );
}
