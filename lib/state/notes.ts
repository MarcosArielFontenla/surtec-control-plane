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
