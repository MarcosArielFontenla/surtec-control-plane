# Surtec Control Plane — Per-Project TODOs / Notes (D.1) — Design

- **Date:** 2026-05-30
- **Status:** Approved design (pre-implementation)
- **Slice:** Per-project TODO/note checklist (theme D "cross-project work", slice D.1 — first D slice)
- **Builds on:** the file-first state store (`lib/state/store.ts`, `lib/state/paths.ts`), the on-card control
  pattern from A.2/A.3

## 1. Context & Goal

Themes A (live status) and B (actions) are complete. Theme D is "cross-project work" — managing what needs
doing across all projects from one place. This first slice adds a **per-project TODO checklist**: persisted,
checkable items you add/toggle/delete from the project card, with a **pending count badge** so you can see at
a glance which projects have open work. It's the **first write/persistence feature** (everything prior was
read-only/derived) and is entirely local (no network).

## 2. Key Decisions

- **Checklist items, persisted per project.** Each item is `{ id, text, done, created_at }`. A project's notes
  live in `state/notes/<projectId>.json` as a `Note[]`, written with the existing atomic `writeJsonAtomic`.
- **Local, so loaded eagerly on card mount** (unlike the gh/npm controls, which must be on-demand for network
  cost). This makes the pending-count badge visible immediately.
- **Path-traversal safety is the key security concern.** `projectId`/`noteId` come from the URL and the
  `projectId` is used in a filename. A shared `isSafeId(s)` (`^[A-Za-z0-9._-]+$`, no `..`, ≤100 chars) gates
  every route (400 on a bad id) so no client value can escape `state/notes/`.
- **Mutations return the full list** (`{ notes }`) so the UI just replaces its state — no client-side merge.
- **Scope: add / toggle / delete.** No in-place text edit, no free-form note blob, no due dates in v1.
- **Validation**: `text` is trimmed, non-empty, ≤500 chars (400 otherwise); `action` ∈ {`toggle`,`delete`}.

## 3. Scope

**In scope (v1):**

- `lib/state/paths.ts` — add `notesDir(base?)`.
- `lib/state/notes.ts` — `Note`, `isSafeId`, `listNotes`, `addNote`, `toggleNote`, `deleteNote`,
  `pendingCount`. Atomic read-modify-write; never throws on a missing file (→ `[]`).
- `dashboard/src/server/index.ts` — `GET /api/projects/:id/notes`, `POST /api/projects/:id/notes`,
  `POST /api/projects/:id/notes/:noteId`.
- `dashboard/src/ui/api.ts` — `getNotes`, `addNote`, `mutateNote`.
- `dashboard/src/ui/components/ProjectNotes.tsx` — a NEW component (the card is already large): mount-load,
  pending badge, expandable CRUD panel.
- `dashboard/src/ui/components/ProjectCard.tsx` — render `<ProjectNotes projectId={p.id} />`.
- `dashboard/src/ui/styles/dashboard.css` — `.es-notes*` styles.

**Out of scope (later):** editing an item's text; free-form note blobs; due dates / priority / tags; reordering;
a cross-project "all notes" view; markdown; sync to GitHub issues; the pending count in the overview poll
(the card loads its own notes, so the badge needs no overview change).

## 4. Architecture

```
On card mount:
  <ProjectNotes projectId> → api.getNotes(id) → GET /api/projects/:id/notes
    if !isSafeId(id) → 400
    return { notes: listNotes(id) }            // [] if the file is absent
  → badge shows pendingCount; expand shows the list.

Add / toggle / delete:
  add:    POST /api/projects/:id/notes { text }              → addNote(id, text)    → { notes }
  toggle: POST /api/projects/:id/notes/:noteId { "toggle" }  → toggleNote(id, nId)  → { notes }
  delete: POST /api/projects/:id/notes/:noteId { "delete" }  → deleteNote(id, nId)  → { notes }
  each: validate isSafeId(id) (+ isSafeId(noteId) for item ops) + body; mutate (read-modify-write atomic);
        return the full list. The UI replaces its state with { notes }.
```

`addNote`'s `id`/`created_at` are injectable (an `idFn`/`now` dep) so tests are deterministic; the store's
`dir` is a parameter (default `notesDir()`), as in the existing store functions.

## 5. Components

### `lib/state/paths.ts`

```ts
export function notesDir(base: string = stateDir()): string {
  return join(base, "notes");
}
```

### `lib/state/notes.ts`

```ts
export interface Note { id: string; text: string; done: boolean; created_at: string }

export function isSafeId(s: string): boolean;   // ^[A-Za-z0-9._-]+$ , no "..", length 1..100
export function listNotes(projectId: string, dir?: string): Note[];
export function addNote(projectId: string, text: string, dir?: string, deps?: { idFn?: () => string; now?: () => string }): Note[];
export function toggleNote(projectId: string, noteId: string, dir?: string): Note[];
export function deleteNote(projectId: string, noteId: string, dir?: string): Note[];
export function pendingCount(notes: Note[]): number;
```

- `isSafeId(s)`: `/^[A-Za-z0-9._-]+$/.test(s) && !s.includes("..") && s.length >= 1 && s.length <= 100`.
- File path: `join(dir ?? notesDir(), projectId + ".json")`.
- `listNotes`: read the file → `Note[]`; ENOENT or unreadable → `[]` (never throws). Filters to objects with
  string `id`/`text`, boolean `done` for resilience.
- `addNote`: `note = { id: deps.idFn?.() ?? randomUUID(), text: text.trim(), done: false, created_at: deps.now?.() ?? new Date().toISOString() }`;
  `next = [...listNotes(projectId, dir), note]`; `writeJsonAtomic(path, next)`; return `next`.
- `toggleNote`: map over the list, flip `done` on the matching `id`; write; return the list (unchanged if no
  match).
- `deleteNote`: filter out the matching `id`; write; return the list.
- `pendingCount(notes)`: `notes.filter(n => !n.done).length`.
- `writeJsonAtomic` is reused (export it from `store.ts` if not already, or duplicate the tiny helper —
  prefer exporting/importing from `store.ts`). The mutations are read-modify-write; acceptable for a
  single-user local tool (no concurrent-writer guarantees needed).

### `dashboard/src/server/index.ts`

```ts
import { isSafeId, listNotes, addNote, toggleNote, deleteNote } from "../../../lib/state/notes";

app.get("/api/projects/:id/notes", (c) => {
  const id = c.req.param("id");
  if (!isSafeId(id)) return c.json({ error: "invalid id" }, 400);
  return c.json({ notes: listNotes(id) });
});

app.post("/api/projects/:id/notes", async (c) => {
  const id = c.req.param("id");
  if (!isSafeId(id)) return c.json({ error: "invalid id" }, 400);
  let body: { text?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  const text = String(body?.text ?? "").trim();
  if (!text || text.length > 500) return c.json({ error: "invalid text" }, 400);
  return c.json({ notes: addNote(id, text) });
});

app.post("/api/projects/:id/notes/:noteId", async (c) => {
  const id = c.req.param("id"); const noteId = c.req.param("noteId");
  if (!isSafeId(id) || !isSafeId(noteId)) return c.json({ error: "invalid id" }, 400);
  let body: { action?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  const action = String(body?.action ?? "");
  if (action === "toggle") return c.json({ notes: toggleNote(id, noteId) });
  if (action === "delete") return c.json({ notes: deleteNote(id, noteId) });
  return c.json({ error: `invalid action: ${action}` }, 400);
});
```

### `dashboard/src/ui/api.ts`

```ts
import type { Note } from "../../../lib/state/notes";

export async function getNotes(id: string): Promise<{ notes: Note[] }>;
export async function addNote(id: string, text: string): Promise<{ notes: Note[] }>;
export async function mutateNote(id: string, noteId: string, action: "toggle" | "delete"): Promise<{ notes: Note[] }>;
```
- `getNotes`: `GET /api/projects/:id/notes`; throws on non-2xx.
- `addNote`: `POST …/notes` `{ text }`; throws on non-2xx (e.g. invalid text 400).
- `mutateNote`: `POST …/notes/:noteId` `{ action }`; throws on non-2xx.

### `dashboard/src/ui/components/ProjectNotes.tsx`

```tsx
export function ProjectNotes({ projectId }: { projectId: string }): JSX.Element;
```
- State: `notes: Note[]`, `open`, `loaded`, `newText`, `busy`.
- `useEffect([projectId])`: `getNotes(projectId).then(r => setNotes(r.notes)).catch(() => {}).finally(() => setLoaded(true))` (mount-load; failures are silent — empty list). Guard `active` flag like `useOverview`.
- Button **`Notas{pending > 0 ? ` (${pending})` : ""}`** (pending = `notes.filter(!done).length`) toggles `open`.
- When `open`: a list — each item: a checkbox (toggle) + the text (struck-through when done) + a `×` (delete);
  a row with an input bound to `newText` + an **Agregar** button (disabled when empty/busy).
- `add()`: `addNote(projectId, newText.trim())` → `setNotes(r.notes); setNewText("")`. `toggle(noteId)`/
  `del(noteId)`: `mutateNote(projectId, noteId, action)` → `setNotes(r.notes)`. All guard `busy` and catch
  errors (shown in a small inline banner). Optimism not required (mutations are fast, local).

### `dashboard/src/ui/components/ProjectCard.tsx`

- Render `<ProjectNotes projectId={p.id} />` after `<DepsStatus project={p} />`. Notes apply to ANY project
  (not gated on git), so it always renders.

### `dashboard/src/ui/styles/dashboard.css`

```css
.es-notes { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-2); }
.es-notes__panel { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-1); }
.es-notes__item { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-body-sm); }
.es-notes__item--done { color: var(--ink-4); text-decoration: line-through; }
.es-notes__add { display: flex; gap: var(--sp-2); }
.es-notes__del { border: 0; background: transparent; color: var(--ink-3); cursor: pointer; }
```

## 6. Data Flow & State Transitions

Notes are persisted to `state/notes/<projectId>.json`. The card loads them once on mount; mutations
read-modify-write the file and return the full list, which the UI swaps in. No change to the overview poll,
dispatch, Procesos, review, git, branch, GitHub, or deps.

## 7. Safety & Governance

- **Path-traversal safe**: every route validates `isSafeId(id)` (and `isSafeId(noteId)` for item ops) before
  the id reaches a filename — no `/`, `\`, `..`, or empty. A bad id → 400, never a filesystem escape.
- **No code execution, no network, no agent** — pure local JSON persistence. `text` is stored as data and
  rendered as text (React escapes it; no HTML injection).
- **Bounded input**: `text` ≤ 500 chars; the action allowlist is 2 values.
- Read-modify-write under a single local user — no locking needed.

## 8. Error Handling

- Invalid id → 400; invalid JSON body → 400; empty/too-long text → 400; invalid action → 400.
- `listNotes` never throws (missing/unreadable file → `[]`); `toggle`/`delete` on a non-existent noteId →
  no-op (returns the unchanged list, HTTP 200).
- The UI `getNotes` failure on mount is silent (empty list); `addNote`/`mutateNote` failures show a small
  inline error and leave the prior list intact.

## 9. Testing (TDD)

- `lib/state/notes.test.ts` (temp dir):
  - `isSafeId`: accepts `appointment-manager`, `a.b_c-1`; rejects ``, `../x`, `a/b`, `a\\b`, `..`, a 101-char
    string.
  - `addNote` (injected `idFn`/`now`): writes a note with the injected id/created_at, `done:false`, trimmed
    text; appends to an existing list; `listNotes` reads it back.
  - `listNotes`: missing file → `[]`; an unreadable/garbage file → `[]` (no throw).
  - `toggleNote`: flips `done` on the matching id; unknown id → unchanged.
  - `deleteNote`: removes the matching id; unknown id → unchanged.
  - `pendingCount`: counts `!done`.
- `dashboard/src/server/index.test.ts` (temp `SURTEC_STATE_DIR`):
  - `POST /notes` then `GET /notes` round-trips the new note; `POST /notes/:id { toggle }` flips done;
    `{ delete }` removes it.
  - invalid id (`..`) → 400; empty text → 400; text > 500 → 400; invalid action → 400; invalid JSON → 400.
- `dashboard/src/ui/components/ProjectNotes.test.tsx` (stub `fetch`):
  - on mount, fetches and shows the pending count badge (e.g. `Notas (2)` for two undone notes);
  - **Agregar** with text POSTs `{ text }` and re-renders the returned list; the input is disabled/cleared;
  - clicking a checkbox POSTs `{ action:"toggle" }`; the `×` POSTs `{ action:"delete" }`;
  - **Agregar** is disabled for empty input.

## 10. Evolution Path

- Edit an item's text; reorder (drag); due dates / priority / tags; free-form markdown notes.
- A cross-project "All notes" / "My todos" view aggregating pending items across repos (the true theme-D
  cross-project inbox).
- Surface the pending count in the overview (a portfolio-level "N projects with open todos").
- Convert a note ↔ a GitHub issue.

## 11. Open Questions

None blocking. Notes live under `state/` (runtime state, local to this control-plane instance; not committed).
`writeJsonAtomic` is reused from the existing store. The pending badge needs no overview change because the
card loads its own notes on mount.
