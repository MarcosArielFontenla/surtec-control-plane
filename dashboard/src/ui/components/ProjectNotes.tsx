import { useEffect, useState } from "react";
import type { Note } from "../../../../lib/state/notes";
import { getNotes, addNote, mutateNote } from "../api";

export function ProjectNotes({ projectId }: { projectId: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [open, setOpen] = useState(false);
  const [newText, setNewText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getNotes(projectId).then((r) => { if (active) setNotes(r.notes ?? []); }).catch(() => {});
    return () => { active = false; };
  }, [projectId]);

  const pending = notes.filter((n) => !n.done).length;

  const add = () => {
    const text = newText.trim();
    if (!text || busy) return;
    setBusy(true); setErr(null);
    addNote(projectId, text)
      .then((r) => { setNotes(r.notes ?? []); setNewText(""); })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  };
  const mutate = (noteId: string, action: "toggle" | "delete") => {
    if (busy) return;
    setBusy(true); setErr(null);
    mutateNote(projectId, noteId, action)
      .then((r) => setNotes(r.notes ?? []))
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  };

  return (
    <span className="notes link-pop">
      <button type="button" className="card-link-btn" onClick={() => setOpen((o) => !o)}>
        Notas{pending > 0 ? ` (${pending})` : ""}
      </button>
      {open && (
        <div className="notes-panel">
          {notes.map((n) => (
            <div key={n.id} className={`notes-item${n.done ? " notes-item--done" : ""}`}>
              <input type="checkbox" checked={n.done} disabled={busy} onChange={() => mutate(n.id, "toggle")} />
              <span>{n.text}</span>
              <button type="button" className="notes-del" disabled={busy} onClick={() => mutate(n.id, "delete")} aria-label="borrar">×</button>
            </div>
          ))}
          <div className="notes-add">
            <input
              className="input" placeholder="nueva nota" value={newText}
              onChange={(e) => setNewText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            />
            <button type="button" className="ghost-btn" disabled={busy || newText.trim() === ""} onClick={add}>Agregar</button>
          </div>
          {err && <div className="banner banner--danger">{err}</div>}
        </div>
      )}
    </span>
  );
}
