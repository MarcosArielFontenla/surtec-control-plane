import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHarnessSource, readContained } from "./source";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() { const root = mkdtempSync(join(tmpdir(), "surtec-source-test-")); roots.push(root); for (const path of ["AGENTS.md", ".agents", "registry"]) cpSync(resolve(path), join(root, path), { recursive: true }); return root; }
describe("trusted Harness source", () => {
  it("pins the explicitly reviewed local source", () => { expect(loadHarnessSource(fixture()).status).toBe("trusted"); });
  it("does not adopt canonical content drift", () => { const root = fixture(); writeFileSync(join(root, "AGENTS.md"), "changed"); const result = loadHarnessSource(root); expect(result.status).toBe("unknown"); expect(result.manifest).toBeNull(); });
  it("rejects manifest drift without changing its bytes", () => { const root = fixture(); const path = join(root, "registry/harness-manifests/surtec-h1-h4.json"); const raw = readFileSync(path, "utf8") + "\n"; writeFileSync(path, raw); expect(loadHarnessSource(root).status).toBe("unknown"); expect(readFileSync(path, "utf8")).toBe(raw); });
  it("fails closed on unsafe and oversized reads", () => { const root = fixture(); expect(() => readContained(root, "../outside")).toThrow(); expect(() => readContained(root, "AGENTS.md", 1)).toThrow(); });
});
