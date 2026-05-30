import { describe, it, expect, vi } from "vitest";
import { resolveOpenCommand, openProject, OpenError } from "./open-project";

describe("resolveOpenCommand", () => {
  it("vscode → editor cmd, shell on win32 only", () => {
    expect(resolveOpenCommand("vscode", "/p", "win32", "code")).toEqual({ command: "code", args: ["/p"], shell: true });
    expect(resolveOpenCommand("vscode", "/p", "darwin", "code")).toEqual({ command: "code", args: ["/p"], shell: false });
  });
  it("vscode honors a custom editor", () => {
    expect(resolveOpenCommand("vscode", "/p", "linux", "cursor")).toEqual({ command: "cursor", args: ["/p"], shell: false });
  });
  it("folder → per-platform explorer/open/xdg-open, no shell", () => {
    expect(resolveOpenCommand("folder", "/p", "win32", "code")).toEqual({ command: "explorer", args: ["/p"], shell: false });
    expect(resolveOpenCommand("folder", "/p", "darwin", "code")).toEqual({ command: "open", args: ["/p"], shell: false });
    expect(resolveOpenCommand("folder", "/p", "linux", "code")).toEqual({ command: "xdg-open", args: ["/p"], shell: false });
  });
});

describe("openProject", () => {
  const discover = () => [{ id: "alpha", path: "/p/alpha" }];

  it("spawns the editor for a discovered project", () => {
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    const r = openProject("/repo", "alpha", "vscode", { discover, spawn, platform: "win32", editorCmd: "code", root: "/root" });
    expect(r).toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledWith("code", ["/p/alpha"], expect.objectContaining({ detached: true, stdio: "ignore", shell: true }));
  });
  it("spawns the folder opener", () => {
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    openProject("/repo", "alpha", "folder", { discover, spawn, platform: "darwin", editorCmd: "code", root: "/root" });
    expect(spawn).toHaveBeenCalledWith("open", ["/p/alpha"], expect.objectContaining({ shell: false }));
  });
  it("throws OpenError 404 for an unknown project and does not spawn", () => {
    const spawn = vi.fn();
    try { openProject("/repo", "ghost", "vscode", { discover, spawn, root: "/root" }); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(OpenError); expect((e as OpenError).status).toBe(404); }
    expect(spawn).not.toHaveBeenCalled();
  });
  it("throws OpenError 400 for an invalid target and does not spawn", () => {
    const spawn = vi.fn();
    try { openProject("/repo", "alpha", "browser", { discover, spawn, root: "/root" }); expect.unreachable(); }
    catch (e) { expect((e as OpenError).status).toBe(400); }
    expect(spawn).not.toHaveBeenCalled();
  });
  it("throws OpenError 500 when spawn throws", () => {
    const spawn = vi.fn(() => { throw new Error("ENOENT: code"); });
    try { openProject("/repo", "alpha", "vscode", { discover, spawn, platform: "linux", editorCmd: "code", root: "/root" }); expect.unreachable(); }
    catch (e) { expect((e as OpenError).status).toBe(500); expect((e as OpenError).message).toContain("ENOENT"); }
  });
  it("rejects an editor command with shell metacharacters on win32", () => {
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    try {
      openProject("/repo", "alpha", "vscode", { discover, spawn, platform: "win32", editorCmd: "code & calc", root: "/root" });
      expect.unreachable();
    } catch (e) {
      expect((e as OpenError).status).toBe(400);
    }
    expect(spawn).not.toHaveBeenCalled();
  });
});
