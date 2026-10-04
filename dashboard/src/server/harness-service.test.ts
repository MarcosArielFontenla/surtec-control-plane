import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarnessService } from "./harness-service";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
describe("Harness service", () => {
  it("GET never creates state; explicit refresh persists only observations", () => {
    const root = mkdtempSync(join(tmpdir(), "surtec-harness-service-")); roots.push(root);
    writeFileSync(join(root, "AGENTS.md"), "Synthetic legacy instructions.");
    const before = readFileSync(join(root, "AGENTS.md")); const path = join(root, "state/harness/profiles.json");
    const service = createHarnessService(root, { policy: { project: (id) => ({ id, repo_path: root } as never) }, statePath: path });
    expect(service.read("alpha").saved).toBeNull(); expect(existsSync(path)).toBe(false);
    const refreshed = service.refresh("alpha"); expect(refreshed.saved).toEqual(refreshed.observation);
    expect(createHarnessService(root, { policy: { project: (id) => ({ id, repo_path: root } as never) }, statePath: path }).read("alpha").saved).toEqual(refreshed.saved);
    expect(readFileSync(join(root, "AGENTS.md"))).toEqual(before);
  });
});
