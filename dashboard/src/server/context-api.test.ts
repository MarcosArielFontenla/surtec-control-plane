import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./index";
import { ContextPreviewError, type ContextService } from "./context-service";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-context-api-")); mkdirSync(join(root, "registry"));
  writeFileSync(join(root, "registry/agents.yml"), "agents: []"); writeFileSync(join(root, "registry/projects.yml"), "projects: {}");
  vi.stubEnv("SURTEC_STATE_DIR", join(root, "state"));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
describe("protected no-effect context endpoints", () => {
  it("requires session/origin protection and bounded JSON before calling preview or scheduling work", async () => {
    const preview = vi.fn(() => ({ allowed: true, fingerprint: "a".repeat(64) })); const roles = vi.fn(() => []); const dispatch = vi.fn();
    const app = createApp(root, dispatch, undefined, undefined, { context: { preview, roles } as unknown as ContextService });
    const { token } = await (await app.request("/api/session")).json();
    const headers = { "X-Surtec-Session": token };
    const path = "/api/context/preview";
    expect((await app.request(path, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await app.request(path, { method: "POST", headers: { ...headers, origin: "https://untrusted.invalid" }, body: "{}" })).status).toBe(403);
    expect((await app.request(path, { method: "POST", headers, body: "{" })).status).toBe(400);
    expect((await app.request(path, { method: "POST", headers, body: JSON.stringify({ instructions: "x".repeat(33 * 1024) }) })).status).toBe(413);
    expect(preview).not.toHaveBeenCalled();
    const result = await app.request(path, { method: "POST", headers, body: JSON.stringify({ kind: "analysis" }) });
    expect(result.status).toBe(200); expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(preview).toHaveBeenCalledOnce(); expect(dispatch).not.toHaveBeenCalled(); expect(existsSync(join(root, "state"))).toBe(false);
    expect((await app.request("/api/projects/alpha/context/roles")).status).toBe(200); expect(roles).toHaveBeenCalledWith("alpha");
  });
  it("reports stale/blocked context safely and does not surface private exception text", async () => {
    const preview = vi.fn(() => { throw new ContextPreviewError("Context preview changed; regenerate before dispatch"); });
    const app = createApp(root, () => {}, undefined, undefined, { context: { preview } as unknown as ContextService });
    const { token } = await (await app.request("/api/session")).json();
    const init = { method: "POST", headers: { "X-Surtec-Session": token }, body: "{}" };
    expect((await app.request("/api/context/preview", init)).status).toBe(409);
    preview.mockImplementation(() => { throw new Error("Synthetic private body C:\\private\\auth.json"); });
    const result = await app.request("/api/context/preview", init);
    expect(result.status).toBe(409); expect(await result.text()).not.toContain("Synthetic private body");
    expect(existsSync(join(root, "state"))).toBe(false);
  });
});
