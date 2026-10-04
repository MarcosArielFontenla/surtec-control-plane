import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./index";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-harness-api-"));
  mkdirSync(join(root, "projects/alpha/.git"), { recursive: true }); mkdirSync(join(root, "registry"));
  writeFileSync(join(root, "registry/agents.yml"), "agents: []\n"); writeFileSync(join(root, "registry/projects.yml"), "projects:\n  alpha: {}\n");
  vi.stubEnv("SURTEC_STATE_DIR", join(root, "state")); vi.stubEnv("SURTEC_PROJECTS_ROOT", join(root, "projects"));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
describe("Harness API", () => {
  it("enforces local session protection, project discovery and read-only Doctor", async () => {
    const app = createApp(root); const path = "/api/projects/alpha/harness";
    expect((await app.request(`${path}/doctor`)).status).toBe(200); expect(existsSync(join(root, "state"))).toBe(false);
    expect((await app.request(`${path}/refresh`, { method: "POST" })).status).toBe(403);
    expect((await app.request("/api/projects/missing/harness")).status).toBe(404);
    const { token } = await (await app.request("/api/session")).json() as { token: string };
    expect((await app.request(`${path}/refresh`, { method: "POST", headers: { "X-Surtec-Session": token } })).status).toBe(200);
    expect(existsSync(join(root, "state/harness/profiles.json"))).toBe(true);
    expect((await app.request(path, { headers: { origin: "https://untrusted.invalid" } })).status).toBe(403);
  });
});
