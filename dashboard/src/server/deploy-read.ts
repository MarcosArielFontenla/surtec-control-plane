import { loadRegistryProjects } from "./registry";
import type { DeployState } from "../../../lib/state/types";

export class DeployError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "DeployError"; }
}

export type DoFetch = (url: string, init: { method: string; signal: AbortSignal }) => Promise<{ status: number }>;
export interface DeployPing { state: DeployState; status: number | null; ms: number; error?: string }

const TIMEOUT_MS = 6000;
const defaultFetch: DoFetch = (url, init) => fetch(url, init);

// Read-only HTTP health-check of a deploy URL. HEAD with a GET fallback, ~6s timeout. Never throws.
export async function readDeployHealth(url: string, deps: { doFetch?: DoFetch; now?: () => number } = {}): Promise<DeployPing> {
  const doFetch = deps.doFetch ?? defaultFetch;
  const now = deps.now ?? Date.now;
  const start = now();

  const ping = async (method: string): Promise<number> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await doFetch(url, { method, signal: ac.signal });
      return res.status;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let status: number;
    try {
      status = await ping("HEAD");
      if (status === 405) status = await ping("GET");
    } catch {
      status = await ping("GET");
    }
    const ms = now() - start;
    return status < 400 ? { state: "up", status, ms } : { state: "degraded", status, ms };
  } catch (e) {
    return { state: "down", status: null, ms: now() - start, error: (e as Error).message };
  }
}

interface ResolveDeps { loadRegistry?: (repoRoot: string) => { id: string; deploy_url?: string | null }[]; }

// Resolves the deploy URL for a project id FROM THE TRUSTED REGISTRY (anti-SSRF). Throws DeployError(404)
// for an unknown id; returns null when the project exists but has no deploy_url.
export function resolveDeployUrl(repoRoot: string, id: string, deps: ResolveDeps = {}): string | null {
  const load = deps.loadRegistry ?? loadRegistryProjects;
  const proj = load(repoRoot).find((p) => p.id === id);
  if (!proj) throw new DeployError(`unknown project: ${id}`, 404);
  return proj.deploy_url ?? null;
}

export interface DeployCache { get(key: string, compute: () => Promise<DeployPing>): Promise<DeployPing>; invalidate(key: string): void }

export function createDeployCache(opts: { ttlMs?: number; now?: () => number } = {}): DeployCache {
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: Promise<DeployPing>; at: number }>();
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
