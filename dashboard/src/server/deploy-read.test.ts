import { describe, it, expect } from "vitest";
import { readDeployHealth, resolveDeployUrl, DeployError, createDeployCache, type DoFetch, type DeployPing } from "./deploy-read";

// A clock that advances 50ms per call, so elapsed ms is deterministic (= 50 between start and end).
function clock() { let t = 0; return () => (t += 50); }

describe("readDeployHealth", () => {
  it("200 → up with measured ms", async () => {
    const doFetch: DoFetch = async () => ({ status: 200 });
    const r = await readDeployHealth("https://x", { doFetch, now: clock() });
    expect(r).toEqual<DeployPing>({ state: "up", status: 200, ms: 50 });
  });

  it("5xx/4xx → degraded carrying the status", async () => {
    const doFetch: DoFetch = async () => ({ status: 503 });
    const r = await readDeployHealth("https://x", { doFetch, now: clock() });
    expect(r).toMatchObject({ state: "degraded", status: 503 });
  });

  it("a thrown fetch (timeout/DNS/refused) → down, never throws", async () => {
    const doFetch: DoFetch = async () => { throw new Error("ECONNREFUSED"); };
    const r = await readDeployHealth("https://x", { doFetch, now: clock() });
    expect(r.state).toBe("down");
    expect(r.status).toBeNull();
    expect(r.error).toContain("ECONNREFUSED");
  });

  it("HEAD returning 405 falls back to GET", async () => {
    const calls: string[] = [];
    const doFetch: DoFetch = async (_url, init) => { calls.push(init.method); return { status: init.method === "HEAD" ? 405 : 200 }; };
    const r = await readDeployHealth("https://x", { doFetch, now: clock() });
    expect(calls).toEqual(["HEAD", "GET"]);
    expect(r.state).toBe("up");
  });

  it("HEAD throwing falls back to GET", async () => {
    const calls: string[] = [];
    const doFetch: DoFetch = async (_url, init) => { calls.push(init.method); if (init.method === "HEAD") throw new Error("no HEAD"); return { status: 200 }; };
    const r = await readDeployHealth("https://x", { doFetch, now: clock() });
    expect(calls).toEqual(["HEAD", "GET"]);
    expect(r.state).toBe("up");
  });
});

describe("resolveDeployUrl", () => {
  const reg = (rows: { id: string; deploy_url?: string | null }[]) => () => rows.map((r) => ({ id: r.id, deploy_url: r.deploy_url ?? null }));
  it("returns the configured url", () => {
    expect(resolveDeployUrl("/root", "a", { loadRegistry: reg([{ id: "a", deploy_url: "https://a.up.railway.app" }]) })).toBe("https://a.up.railway.app");
  });
  it("returns null when the project has no deploy_url", () => {
    expect(resolveDeployUrl("/root", "a", { loadRegistry: reg([{ id: "a" }]) })).toBeNull();
  });
  it("throws DeployError(404) for an unknown project", () => {
    expect(() => resolveDeployUrl("/root", "nope", { loadRegistry: reg([{ id: "a" }]) })).toThrow(DeployError);
  });
});

describe("createDeployCache", () => {
  it("serves cached within TTL and recomputes after", async () => {
    let t = 0; let calls = 0;
    const cache = createDeployCache({ ttlMs: 100, now: () => t });
    const compute = async (): Promise<DeployPing> => { calls++; return { state: "up", status: 200, ms: 1 }; };
    await cache.get("https://x", compute);
    await cache.get("https://x", compute);
    expect(calls).toBe(1);
    t = 200;
    await cache.get("https://x", compute);
    expect(calls).toBe(2);
  });
});
