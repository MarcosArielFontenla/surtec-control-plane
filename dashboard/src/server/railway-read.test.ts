import { describe, it, expect } from "vitest";
import { readRailwayDeploy, resolveRailway, RailwayError, createRailwayCache, type DoFetch, type RailwayPing, type RailwayIds } from "./railway-read";

const ids: RailwayIds = { project_id: "p1", service_id: "s1", environment_id: "e1" };
const okResp = (node: unknown) => ({ status: 200, json: async () => ({ data: { deployments: { edges: node ? [{ node }] : [] } } }) });

describe("readRailwayDeploy", () => {
  it("parses the latest deployment node and maps the status to a lowercase state", async () => {
    const doFetch: DoFetch = async () => okResp({ id: "d1", status: "SUCCESS", url: "https://x.up.railway.app", createdAt: "2026-05-30T10:00:00Z" });
    const r = await readRailwayDeploy(ids, "tok", { doFetch });
    expect(r).toEqual<RailwayPing>({ ok: true, state: "success", at: "2026-05-30T10:00:00Z", url: "https://x.up.railway.app" });
  });

  it("maps each known status; unknown enum → 'unknown'", async () => {
    for (const [raw, mapped] of [["BUILDING", "building"], ["FAILED", "failed"], ["CRASHED", "crashed"], ["WEIRD", "unknown"]] as const) {
      const doFetch: DoFetch = async () => okResp({ status: raw, url: null, createdAt: "t" });
      expect((await readRailwayDeploy(ids, "tok", { doFetch })).state).toBe(mapped);
    }
  });

  it("sends a Bearer token and the deployments query with the ids", async () => {
    let captured: { headers: Record<string, string>; body: string } | null = null;
    const doFetch: DoFetch = async (_url, init) => { captured = init; return okResp({ status: "SUCCESS", url: null, createdAt: "t" }); };
    await readRailwayDeploy(ids, "secret", { doFetch });
    expect(captured!.headers.Authorization).toBe("Bearer secret");
    const body = JSON.parse(captured!.body);
    expect(body.query).toContain("deployments");
    expect(body.variables.input).toEqual({ projectId: "p1", serviceId: "s1", environmentId: "e1" });
  });

  it("empty edges → { ok:false }", async () => {
    const doFetch: DoFetch = async () => okResp(null);
    expect((await readRailwayDeploy(ids, "tok", { doFetch })).ok).toBe(false);
  });

  it("HTTP non-2xx → { ok:false, error }", async () => {
    const doFetch: DoFetch = async () => ({ status: 401, json: async () => ({}) });
    const r = await readRailwayDeploy(ids, "tok", { doFetch });
    expect(r.ok).toBe(false); expect(r.error).toContain("401");
  });

  it("a GraphQL errors array → { ok:false }", async () => {
    const doFetch: DoFetch = async () => ({ status: 200, json: async () => ({ errors: [{ message: "Problem processing request" }] }) });
    const r = await readRailwayDeploy(ids, "tok", { doFetch });
    expect(r.ok).toBe(false); expect(r.error).toContain("Problem");
  });

  it("a thrown fetch (timeout/network) → { ok:false }, never throws", async () => {
    const doFetch: DoFetch = async () => { throw new Error("ECONNRESET"); };
    const r = await readRailwayDeploy(ids, "tok", { doFetch });
    expect(r.ok).toBe(false); expect(r.error).toContain("ECONNRESET");
  });
});

describe("resolveRailway", () => {
  const reg = (rows: { id: string; railway?: RailwayIds | null }[]) => () => rows.map((r) => ({ id: r.id, railway: r.railway ?? null }));
  it("returns the ids block", () => {
    expect(resolveRailway("/root", "a", { loadRegistry: reg([{ id: "a", railway: ids }]) })).toEqual(ids);
  });
  it("returns null when the project has no railway block", () => {
    expect(resolveRailway("/root", "a", { loadRegistry: reg([{ id: "a" }]) })).toBeNull();
  });
  it("throws RailwayError(404) for an unknown project", () => {
    expect(() => resolveRailway("/root", "nope", { loadRegistry: reg([{ id: "a" }]) })).toThrow(RailwayError);
  });
});

describe("createRailwayCache", () => {
  it("serves cached within TTL and recomputes after", async () => {
    let t = 0; let calls = 0;
    const cache = createRailwayCache({ ttlMs: 100, now: () => t });
    const compute = async (): Promise<RailwayPing> => { calls++; return { ok: true, state: "success", at: "t", url: null }; };
    await cache.get("s1", compute);
    await cache.get("s1", compute);
    expect(calls).toBe(1);
    t = 200;
    await cache.get("s1", compute);
    expect(calls).toBe(2);
  });
});
