import { describe, it, expect, vi } from "vitest";
import { readDepsStatus, resolveDepsPath, DepsError } from "./deps-read";

describe("readDepsStatus", () => {
  it("counts outdated deps and ignores npm's exit-1-when-outdated; uses npm outdated --json at cwd", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 1, stdout: '{"a":{},"b":{}}' });
    const exists = vi.fn().mockReturnValue(true);
    const r = readDepsStatus("/p", { spawnSync: spawnSync as never, exists });
    expect(r).toEqual({ ok: true, outdated: 2 });
    expect(spawnSync.mock.calls[0][1]).toEqual(["outdated", "--json"]);
    expect((spawnSync.mock.calls[0][2] as { cwd: string }).cwd).toBe("/p");
  });

  it("returns outdated:0 for an empty npm result", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, stdout: "{}" });
    expect(readDepsStatus("/p", { spawnSync: spawnSync as never, exists: () => true })).toEqual({ ok: true, outdated: 0 });
  });

  it("treats empty stdout as no outdated", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, stdout: "" });
    expect(readDepsStatus("/p", { spawnSync: spawnSync as never, exists: () => true })).toEqual({ ok: true, outdated: 0 });
  });

  it("ok:false 'sin package.json' when there is no package.json (npm NOT spawned)", () => {
    const spawnSync = vi.fn();
    const r = readDepsStatus("/p", { spawnSync: spawnSync as never, exists: () => false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sin package.json/);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("ok:false 'n/a (npm install)' when node_modules is missing (npm NOT spawned)", () => {
    const spawnSync = vi.fn();
    const exists = vi.fn().mockImplementation((p: string) => p.endsWith("package.json"));
    const r = readDepsStatus("/p", { spawnSync: spawnSync as never, exists });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/npm install/);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("ok:false on spawn error", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: null, error: new Error("spawn npm ENOENT") });
    const r = readDepsStatus("/p", { spawnSync: spawnSync as never, exists: () => true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ENOENT/);
  });

  it("ok:false on non-JSON npm output", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 1, stdout: "not json" });
    const r = readDepsStatus("/p", { spawnSync: spawnSync as never, exists: () => true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bad npm output/);
  });

  it("ok:false on a non-object JSON (array)", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, stdout: "[]" });
    const r = readDepsStatus("/p", { spawnSync: spawnSync as never, exists: () => true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bad npm output/);
  });
});

describe("resolveDepsPath", () => {
  it("resolves a discovered project path", () => {
    expect(resolveDepsPath("/repo", "alpha", { discover: () => [{ id: "alpha", path: "/p/alpha" }], root: "/root" })).toBe("/p/alpha");
  });
  it("throws DepsError(404) for an unknown project", () => {
    expect(() => resolveDepsPath("/repo", "ghost", { discover: () => [], root: "/root" })).toThrow(DepsError);
  });
});
