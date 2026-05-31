import { loadRegistryProjects } from "./registry";
import type { RailwayState } from "../../../lib/state/types";

export class RailwayError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "RailwayError"; }
}

export interface RailwayIds { project_id: string; service_id: string; environment_id: string }
export type DoFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;
export interface RailwayPing { ok: boolean; state: RailwayState | null; at: string | null; url: string | null; error?: string }

const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const TIMEOUT_MS = 10_000;
const QUERY = `query latestDeployment($input: DeploymentListInput!) {
  deployments(input: $input, first: 1) { edges { node { id status url createdAt } } }
}`;

const STATE_MAP: Record<string, RailwayState> = {
  SUCCESS: "success", BUILDING: "building", DEPLOYING: "deploying", FAILED: "failed",
  CRASHED: "crashed", REMOVED: "removed", SLEEPING: "sleeping", SKIPPED: "skipped",
  WAITING: "waiting", QUEUED: "queued",
};

const defaultFetch: DoFetch = (url, init) => fetch(url, init);

interface GqlResp { errors?: { message?: string }[]; data?: { deployments?: { edges?: { node?: { status?: string; url?: string | null; createdAt?: string } }[] } } }

// Reads the latest Railway deployment via the read-only GraphQL `deployments` query. Never throws.
export async function readRailwayDeploy(ids: RailwayIds, token: string, deps: { doFetch?: DoFetch } = {}): Promise<RailwayPing> {
  const doFetch = deps.doFetch ?? defaultFetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: QUERY, variables: { input: { projectId: ids.project_id, serviceId: ids.service_id, environmentId: ids.environment_id } } }),
      signal: ac.signal,
    });
    if (res.status < 200 || res.status >= 300) return { ok: false, state: null, at: null, url: null, error: `HTTP ${res.status}` };
    const body = (await res.json()) as GqlResp;
    if (body.errors && body.errors.length) {
      return { ok: false, state: null, at: null, url: null, error: (body.errors.map((e) => e.message ?? "").join("; ") || "graphql error").slice(0, 500) };
    }
    const node = body.data?.deployments?.edges?.[0]?.node;
    if (!node) return { ok: false, state: null, at: null, url: null, error: "sin deployments" };
    return { ok: true, state: STATE_MAP[node.status ?? ""] ?? "unknown", at: node.createdAt ?? null, url: node.url ?? null };
  } catch (e) {
    return { ok: false, state: null, at: null, url: null, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

interface ResolveDeps { loadRegistry?: (repoRoot: string) => { id: string; railway?: RailwayIds | null }[]; }

// Resolves a project's Railway ids FROM THE TRUSTED REGISTRY (anti-injection). Throws RailwayError(404)
// for an unknown id; returns null when the project has no railway block.
export function resolveRailway(repoRoot: string, id: string, deps: ResolveDeps = {}): RailwayIds | null {
  const load = deps.loadRegistry ?? loadRegistryProjects;
  const proj = load(repoRoot).find((p) => p.id === id);
  if (!proj) throw new RailwayError(`unknown project: ${id}`, 404);
  return proj.railway ?? null;
}

export interface RailwayCache { get(key: string, compute: () => Promise<RailwayPing>): Promise<RailwayPing>; invalidate(key: string): void }

export function createRailwayCache(opts: { ttlMs?: number; now?: () => number } = {}): RailwayCache {
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: Promise<RailwayPing>; at: number }>();
  return {
    get(key, compute) {
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      const value = compute();
      cache.set(key, { value, at: now() });
      return value;
    },
    invalidate(key) { cache.delete(key); },
  };
}
