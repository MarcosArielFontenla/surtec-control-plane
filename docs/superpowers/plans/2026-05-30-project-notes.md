# Per-Project TODOs / Notes (D.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-project TODO checklist — persisted, add/toggle/delete from the project card, with a pending-count badge.

**Architecture:** A new `lib/state/notes.ts` persists `Note[]` per project to `state/notes/<id>.json` via the existing atomic writer; `isSafeId` guards the URL-supplied id against path traversal. Three Hono routes (list/add/mutate) return the full list; a new `ProjectNotes` component loads notes on mount (local, fast), shows a pending badge, and an expandable CRUD panel.

**Tech Stack:** TypeScript ESM, Node `fs`, Hono, React 18 + Vite, Vitest + Testing Library/jsdom.

**Spec:** `docs/superpowers/specs/2026-05-30-project-notes-design.md`

---

## File Structure

**Create:**
- `lib/state/notes.ts` — `Note`, `isSafeId`, `listNotes`, `addNote`, `toggleNote`, `deleteNote`, `pendingCount`.
- `lib/state/notes.test.ts`.
- `dashboard/src/ui/components/ProjectNotes.tsx` — mount-load + badge + CRUD panel.
- `dashboard/src/ui/components/ProjectNotes.test.tsx`.

**Modify:**
- `lib/state/paths.ts` — add `notesDir(base?)`.
- `lib/state/store.ts` — export the existing `writeJsonAtomic` helper.
- `dashboard/src/server/index.ts` — 3 notes routes.
- `dashboard/src/server/index.test.ts` — notes route tests.
- `dashboard/src/ui/api.ts` — `getNotes`, `addNote`, `mutateNote`.
- `dashboard/src/ui/components/ProjectCard.tsx` — render `<ProjectNotes projectId={p.id} />`.
- `dashboard/src/ui/styles/dashboard.css` — `.es-notes*` styles.

---

## Task 1: `lib/state/notes.ts` (store + isSafeId)

**Files:**
- Modify: `lib/state/paths.ts`
- Modify: `lib/state/store.ts`
- Create: `lib/state/notes.ts`
- Test: `lib/state/notes.test.ts`

- [ ] **Step 1: Write the failing tests** — Create `lib/state/notes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSafeId, listNotes, addNote, toggleNote, deleteNote, pendingCount } from "./notes";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "notes-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("isSafeId", () => {
  it("accepts folder-name ids", () => {
    for (const s of ["appointment-manager", "a.b_c-1", "x"]) expect(isSafeId(s)).toBe(true);
  });
  it("rejects unsafe ids", () => {
    for (const s of ["", "../x", "a/b", "a\\b", "..", "a..b", "a".repeat(101)]) expect(isSafeId(s)).toBe(false);
  });
});

describe("notes CRUD", () => {
  it("addNote writes a trimmed note and listNotes reads it back", () => {
    const r = addNote("alpha", "  buy milk  ", dir, { idFn: () => "n1", now: () => "2026-05-30T00:00:00Z" });
    expect(r).toEqual([{ id: "n1", text: "buy milk", done: false, created_at: "2026-05-30T00:00:00Z" }]);
    expect(listNotes("alpha", dir)).toEqual(r);
  });

  it("appends to an existing list", () => {
    addNote("alpha", "first", dir, { idFn: () => "n1", now: () => "t" });
    const r = addNote("alpha", "second", dir, { idFn: () => "n2", now: () => "t" });
    expect(r.map((n) => n.id)).toEqual(["n1", "n2"]);
  });

  it("listNotes returns [] for a missing file", () => {
    expect(listNotes("ghost", dir)).toEqual([]);
  });

  it("listNotes returns [] for a garbage file (no throw)", () => {
    writeFileSync(join(dir, "bad.json"), "not json", "utf8");
    expect(listNotes("bad", dir)).toEqual([]);
  });

  it("toggleNote flips done; unknown id is a no-op", () => {
    addNote("alpha", "x", dir, { idFn: () => "n1", now: () => "t" });
    expect(toggleNote("alpha", "n1", dir)[0].done).toBe(true);
    expect(toggleNote("alpha", "n1", dir)[0].done).toBe(false);
    expect(toggleNote("alpha", "nope", dir)[0].done).toBe(false);
  });

  it("deleteNote removes the matching id", () => {
    addNote("alpha", "x", dir, { idFn: () => "n1", now: () => "t" });
    addNote("alpha", "y", dir, { idFn: () => "n2", now: () => "t" });
    expect(deleteNote("alpha", "n1", dir).map((n) => n.id)).toEqual(["n2"]);
  });

  it("pendingCount counts undone notes", () => {
    expect(pendingCount([
      { id: "1", text: "a", done: false, created_at: "t" },
      { id: "2", text: "b", done: true, created_at: "t" },
    ])).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run lib/state/notes.test.ts`
Expected: FAIL — `Cannot find module './notes'`.

- [ ] **Step 3: Implement**

In `lib/state/paths.ts`, add (after `projectsDir`):

```ts
export function notesDir(base: string = stateDir()): string {
  return join(base, "notes");
}
```

In `lib/state/store.ts`, change the `writeJsonAtomic` declaration to be exported:

```ts
export function writeJsonAtomic(filePath: string, data: unknown): void {
```

Create `lib/state/notes.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeJsonAtomic } from "./store";
import { notesDir } from "./paths";

export interface Note { id: string; text: string; done: boolean; created_at: string }

const ID_RE = /^[A-Za-z0-9._-]+$/;

// Safe for use as a filename segment: charset only, no "..", length 1..100. Guards URL-supplied ids
// against path traversal before they reach a filesystem path.
export function isSafeId(s: string): boolean {
  return typeof s === "string" && s.length >= 1 && s.length <= 100 && !s.includes("..") && ID_RE.test(s);
}

function notePath(projectId: string, dir: string): string {
  return join(dir, `${projectId}.json`);
}

export function listNotes(projectId: string, dir: string = notesDir()): Note[] {
  try {
    const raw = JSON.parse(readFileSync(notePath(projectId, dir), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter((n): n is Note =>
      n && typeof n.id === "string" && typeof n.text === "string" && typeof n.done === "boolean" && typeof n.created_at === "string");
  } catch {
    return [];
  }
}

export function addNote(
  projectId: string, text: string, dir: string = notesDir(),
  deps: { idFn?: () => string; now?: () => string } = {},
): Note[] {
  const note: Note = {
    id: deps.idFn?.() ?? randomUUID(),
    text: text.trim(),
    done: false,
    created_at: deps.now?.() ?? new Date().toISOString(),
  };
  const next = [...listNotes(projectId, dir), note];
  writeJsonAtomic(notePath(projectId, dir), next);
  return next;
}

export function toggleNote(projectId: string, noteId: string, dir: string = notesDir()): Note[] {
  const next = listNotes(projectId, dir).map((n) => (n.id === noteId ? { ...n, done: !n.done } : n));
  writeJsonAtomic(notePath(projectId, dir), next);
  return next;
}

export function deleteNote(projectId: string, noteId: string, dir: string = notesDir()): Note[] {
  const next = listNotes(projectId, dir).filter((n) => n.id !== noteId);
  writeJsonAtomic(notePath(projectId, dir), next);
  return next;
}

export function pendingCount(notes: Note[]): number {
  return notes.filter((n) => !n.done).length;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run lib/state/notes.test.ts`
Expected: PASS (10 tests). Also `pnpm exec tsc --noEmit` → clean (store's `writeJsonAtomic` is now exported and imported by notes).

- [ ] **Step 5: Commit**

```bash
git add lib/state/paths.ts lib/state/store.ts lib/state/notes.ts lib/state/notes.test.ts
git commit -m "feat(state): notes store (isSafeId + list/add/toggle/delete/pendingCount)"
```

---

## Task 2: Notes routes

**Files:**
- Modify: `dashboard/src/server/index.ts`
- Test: `dashboard/src/server/index.test.ts`

- [ ] **Step 1: Add the failing tests** — add this describe block to `dashboard/src/server/index.test.ts` (`mkdtempSync`/`rmSync`/`tmpdir`/`join` are already imported; `beforeEach`/`afterEach` are imported from vitest at the top):

```ts
describe("notes routes", () => {
  let notesStateDir: string;
  beforeEach(() => { notesStateDir = mkdtempSync(join(tmpdir(), "surtec-notes-state-")); process.env.SURTEC_STATE_DIR = notesStateDir; });
  afterEach(() => { delete process.env.SURTEC_STATE_DIR; rmSync(notesStateDir, { recursive: true, force: true }); });

  it("POST then GET round-trips a note; toggle then delete mutate it", async () => {
    const app = createApp(process.cwd());
    const add = await app.request("/api/projects/alpha/notes", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "do the thing" }),
    });
    expect(add.status).toBe(200);
    const notes = ((await add.json()) as { notes: { id: string; done: boolean }[] }).notes;
    expect(notes).toHaveLength(1);
    const nid = notes[0].id;

    const list = await app.request("/api/projects/alpha/notes");
    expect(((await list.json()) as { notes: unknown[] }).notes).toHaveLength(1);

    const tog = await app.request(`/api/projects/alpha/notes/${nid}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "toggle" }),
    });
    expect((((await tog.json()) as { notes: { done: boolean }[] }).notes)[0].done).toBe(true);

    const del = await app.request(`/api/projects/alpha/notes/${nid}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete" }),
    });
    expect(((await del.json()) as { notes: unknown[] }).notes).toHaveLength(0);
  });

  it("rejects an unsafe project id (contains '..') with 400", async () => {
    const app = createApp(process.cwd());
    const res = await app.request("/api/projects/a..b/notes");
    expect(res.status).toBe(400);
  });

  it("rejects empty text with 400", async () => {
    const app = createApp(process.cwd());
    const res = await app.request("/api/projects/alpha/notes", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects text over 500 chars with 400", async () => {
    const app = createApp(process.cwd());
    const res = await app.request("/api/projects/alpha/notes", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "a".repeat(501) }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid action with 400", async () => {
    const app = createApp(process.cwd());
    const res = await app.request("/api/projects/alpha/notes/n1", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "nuke" }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: FAIL — the notes routes are missing.

- [ ] **Step 3: Implement** — in `dashboard/src/server/index.ts`:

1. Add the import (next to the other `lib/state` imports near the top):

```ts
import { isSafeId, listNotes, addNote, toggleNote, deleteNote } from "../../../lib/state/notes";
```

2. After the `GET /api/projects/:id/deps` route (and before `return app;`), add:

```ts
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
    const id = c.req.param("id");
    const noteId = c.req.param("noteId");
    if (!isSafeId(id) || !isSafeId(noteId)) return c.json({ error: "invalid id" }, 400);
    let body: { action?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const action = String(body?.action ?? "");
    if (action === "toggle") return c.json({ notes: toggleNote(id, noteId) });
    if (action === "delete") return c.json({ notes: deleteNote(id, noteId) });
    return c.json({ error: `invalid action: ${action}` }, 400);
  });
```

> `addNote`/`toggleNote`/`deleteNote`/`listNotes` use `notesDir()` (→ `SURTEC_STATE_DIR ?? ./state`), which the tests pin to a temp dir. No `dir` argument is passed in the routes.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full server suite (no regressions)**

Run: `pnpm exec vitest run dashboard/src/server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/server/index.ts dashboard/src/server/index.test.ts
git commit -m "feat(server): per-project notes routes (list/add/toggle/delete, isSafeId-guarded)"
```

---

## Task 3: API client

**Files:**
- Modify: `dashboard/src/ui/api.ts`

- [ ] **Step 1: Implement** — append to `dashboard/src/ui/api.ts`:

```ts
import type { Note } from "../../../lib/state/notes";

export async function getNotes(id: string): Promise<{ notes: Note[] }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/notes`);
  if (!res.ok) throw new Error(`notes failed: ${res.status}`);
  return (await res.json()) as { notes: Note[] };
}

export async function addNote(id: string, text: string): Promise<{ notes: Note[] }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/notes`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `add note failed: ${res.status}`);
  }
  return (await res.json()) as { notes: Note[] };
}

export async function mutateNote(id: string, noteId: string, action: "toggle" | "delete"): Promise<{ notes: Note[] }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/notes/${encodeURIComponent(noteId)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `note ${action} failed: ${res.status}`);
  }
  return (await res.json()) as { notes: Note[] };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/ui/api.ts
git commit -m "feat(ui): notes api client (getNotes/addNote/mutateNote)"
```

## Context for Task 3
The `Note` TYPE is imported from `lib/state/notes` (importing the type from a server module is consistent with the existing `import type { OverviewModel } from "../../../lib/state/types"`). The api's exported `addNote` does NOT collide with the store's `addNote` — only the `Note` type is imported here, not the function. Mirrors the existing client shape (throw on non-2xx).

---

## Task 4: `ProjectNotes` component + card render + styles

**Files:**
- Create: `dashboard/src/ui/components/ProjectNotes.tsx`
- Test: `dashboard/src/ui/components/ProjectNotes.test.tsx`
- Modify: `dashboard/src/ui/components/ProjectCard.tsx`
- Modify: `dashboard/src/ui/styles/dashboard.css`

- [ ] **Step 1: Write the failing tests** — Create `dashboard/src/ui/components/ProjectNotes.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProjectNotes } from "./ProjectNotes";

afterEach(() => vi.unstubAllGlobals());

describe("ProjectNotes", () => {
  it("loads notes on mount and shows the pending count badge", async () => {
    const notes = [{ id: "1", text: "a", done: false, created_at: "t" }, { id: "2", text: "b", done: false, created_at: "t" }];
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ notes }) })) as unknown as typeof fetch);
    render(<ProjectNotes projectId="alpha" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /notas \(2\)/i })).toBeTruthy());
  });

  it("adds a note: posts { text } and renders the returned list", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return { ok: true, status: 200, json: async () => ({ notes: [] }) };
      return { ok: true, status: 200, json: async () => ({ notes: [{ id: "1", text: "do x", done: false, created_at: "t" }] }) };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<ProjectNotes projectId="alpha" />);
    fireEvent.click(await screen.findByRole("button", { name: /^notas$/i }));
    fireEvent.change(screen.getByPlaceholderText(/nueva/i), { target: { value: "do x" } });
    fireEvent.click(screen.getByRole("button", { name: /agregar/i }));
    await waitFor(() => expect(screen.getByText("do x")).toBeTruthy());
    const post = (fetchMock.mock.calls as unknown[][]).find(
      (c) => (c[1] as RequestInit)?.method === "POST" && String(c[0]).endsWith("/api/projects/alpha/notes"),
    );
    expect(JSON.parse((post![1] as RequestInit).body as string).text).toBe("do x");
  });

  it("Agregar is disabled for empty input", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ notes: [] }) })) as unknown as typeof fetch);
    render(<ProjectNotes projectId="alpha" />);
    fireEvent.click(await screen.findByRole("button", { name: /^notas$/i }));
    expect((screen.getByRole("button", { name: /agregar/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("toggling an item posts { action: 'toggle' }", async () => {
    const initial = [{ id: "1", text: "a", done: false, created_at: "t" }];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return { ok: true, status: 200, json: async () => ({ notes: initial }) };
      return { ok: true, status: 200, json: async () => ({ notes: [{ id: "1", text: "a", done: true, created_at: "t" }] }) };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<ProjectNotes projectId="alpha" />);
    fireEvent.click(await screen.findByRole("button", { name: /notas \(1\)/i }));
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => {
      const post = (fetchMock.mock.calls as unknown[][]).find(
        (c) => (c[1] as RequestInit)?.method === "POST" && String(c[0]).endsWith("/api/projects/alpha/notes/1"),
      );
      expect(JSON.parse((post![1] as RequestInit).body as string).action).toBe("toggle");
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run dashboard/src/ui/components/ProjectNotes.test.tsx`
Expected: FAIL — `Cannot find module './ProjectNotes'`.

- [ ] **Step 3: Implement** — Create `dashboard/src/ui/components/ProjectNotes.tsx`:

```tsx
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
    getNotes(projectId).then((r) => { if (active) setNotes(r.notes); }).catch(() => {});
    return () => { active = false; };
  }, [projectId]);

  const pending = notes.filter((n) => !n.done).length;

  const add = () => {
    const text = newText.trim();
    if (!text || busy) return;
    setBusy(true); setErr(null);
    addNote(projectId, text)
      .then((r) => { setNotes(r.notes); setNewText(""); })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  };
  const mutate = (noteId: string, action: "toggle" | "delete") => {
    if (busy) return;
    setBusy(true); setErr(null);
    mutateNote(projectId, noteId, action)
      .then((r) => setNotes(r.notes))
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="es-notes">
      <button type="button" className="es-btn es-btn--ghost" onClick={() => setOpen((o) => !o)}>
        Notas{pending > 0 ? ` (${pending})` : ""}
      </button>
      {open && (
        <div className="es-notes__panel">
          {notes.map((n) => (
            <div key={n.id} className={`es-notes__item${n.done ? " es-notes__item--done" : ""}`}>
              <input type="checkbox" checked={n.done} disabled={busy} onChange={() => mutate(n.id, "toggle")} />
              <span>{n.text}</span>
              <button type="button" className="es-notes__del" disabled={busy} onClick={() => mutate(n.id, "delete")} aria-label="borrar">×</button>
            </div>
          ))}
          <div className="es-notes__add">
            <input
              className="es-input" placeholder="nueva nota" value={newText}
              onChange={(e) => setNewText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            />
            <button type="button" className="es-btn es-btn--ghost" disabled={busy || newText.trim() === ""} onClick={add}>Agregar</button>
          </div>
          {err && <div className="es-banner es-banner--danger">{err}</div>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Render it in the card** — in `dashboard/src/ui/components/ProjectCard.tsx`:

1. Add the import (with the other component imports at the top):

```tsx
import { ProjectNotes } from "./ProjectNotes";
```

2. Render it right after the `<DepsStatus project={p} />` line:

```tsx
      <ProjectNotes projectId={p.id} />
```

- [ ] **Step 5: Add the CSS** — append to `dashboard/src/ui/styles/dashboard.css`:

```css
/* project notes */
.es-notes { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-2); }
.es-notes__panel { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-1); }
.es-notes__item { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-body-sm); }
.es-notes__item--done { color: var(--ink-4); text-decoration: line-through; }
.es-notes__add { display: flex; gap: var(--sp-2); }
.es-notes__del { border: 0; background: transparent; color: var(--ink-3); cursor: pointer; font-size: var(--fs-body); }
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm exec vitest run dashboard/src/ui/components/ProjectNotes.test.tsx dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: PASS (the 4 ProjectNotes tests + the existing ProjectCard tests — ProjectCard now renders ProjectNotes, which fetches on mount; the existing ProjectCard tests stub `fetch` or don't, but ProjectNotes' mount fetch is fire-and-forget and catches errors, so it won't break them).

> If an existing ProjectCard test fails because ProjectNotes' mount `getNotes` fetch is unstubbed and rejects, that's fine — the `.catch(() => {})` swallows it. If a test asserts on the exact number of fetch calls, narrow it. No such assertion is expected.

- [ ] **Step 7: Typecheck + build**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: both succeed.

- [ ] **Step 8: Commit**

```bash
git add dashboard/src/ui/components/ProjectNotes.tsx dashboard/src/ui/components/ProjectNotes.test.tsx dashboard/src/ui/components/ProjectCard.tsx dashboard/src/ui/styles/dashboard.css
git commit -m "feat(ui): ProjectNotes (per-project TODO checklist + pending badge)"
```

## Context for Task 4
`ProjectNotes` loads notes on mount (`useEffect [projectId]`, `active` guard like `useOverview`), shows a `Notas (N)` badge (N = pending), and an expandable panel with a checkbox (toggle) + `×` (delete) per item and an add input (Enter or Agregar). Mutations replace the list with the server's returned `{ notes }`. It renders for EVERY project (notes are not gated on git). `useState`/`useEffect` are standard React imports.

---

## Task 5: Full verification + manual smoke + finish the branch

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all suites green (existing 298 + new: notes store (10), notes routes (5), ProjectNotes (4)).

- [ ] **Step 2: Typecheck + build**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: both succeed.

- [ ] **Step 3: Manual smoke (REQUIRED — use the verification-before-completion skill)**

Start the API server (`PORT=4319 pnpm exec tsx dashboard/src/server/serve.ts` in the background). Then over HTTP:
- `POST /api/projects/appointment-manager/notes` `{ "text": "smoke test note" }` → `200 { notes:[{id,text,done:false,...}] }`. Then `GET /api/projects/appointment-manager/notes` → the same note. Then
  `POST /api/projects/appointment-manager/notes/<id>` `{ "action":"toggle" }` → `done:true`; `{ "action":"delete" }` → empty list.
- `GET /api/projects/a..b/notes` → `400` (path-traversal guard). `POST …/notes` with `{ "text":"" }` → `400`.
- Confirm the note file was created under the state dir (default `./state/notes/appointment-manager.json`) and is gone after delete.
- (Optional) In the browser: open a project card, click **Notas**, add a todo, check it off, delete it; confirm the `(N)` badge tracks pending count.
- Clean up: ensure no stray smoke note remains (delete it, or remove `state/notes/appointment-manager.json` if you created it under the repo's `./state`).

Capture the actual observed output. If anything fails, switch to systematic-debugging. Kill the test server.

- [ ] **Step 4: Finish the branch (use the finishing-a-development-branch skill)**

Merge `--no-ff` to `master`, push to `origin/master`, delete the feature branch. Then update the memory file
`live-status-dashboard-slice.md` to add the D.1 slice (the first theme-D / first write-persistence slice).

---

## Self-Review (completed during planning)

- **Spec coverage:** Note model + persistence + isSafeId + CRUD + pendingCount → Task 1; notesDir + exported
  writeJsonAtomic → Task 1; routes (list/add/mutate, isSafeId-guarded, text/action validation) → Task 2; api
  client → Task 3; ProjectNotes (mount-load, pending badge, CRUD panel) + card render + CSS → Task 4;
  verification + finish → Task 5. All spec sections covered.
- **Placeholder scan:** no TODO/TBD; every code step has complete code (store, routes, api, component, tests,
  CSS).
- **Type consistency:** `Note { id, text, done, created_at }` defined once (Task 1) and imported as a type by
  the api (Task 3) and component (Task 4). `isSafeId`/`listNotes`/`addNote`/`toggleNote`/`deleteNote`/
  `pendingCount` names consistent across Tasks 1-2. `getNotes`/`addNote`/`mutateNote(id, noteId, action)` api
  signatures consistent between Task 3 and Task 4. The mutations' `{ notes }` shape is consistent across
  store → route → api → component. The api's exported `addNote` (HTTP client) is distinct from the store's
  `addNote` (only the `Note` type is imported into api.ts, not the function).
