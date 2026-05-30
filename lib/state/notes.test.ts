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

  it("backstop: addNote throws on an unsafe id (defense-in-depth)", () => {
    expect(() => addNote("../x", "t", dir, { idFn: () => "n", now: () => "t" })).toThrow(/unsafe/);
  });

  it("listNotes returns [] for an unsafe id (no throw)", () => {
    expect(listNotes("../x", dir)).toEqual([]);
  });
});
