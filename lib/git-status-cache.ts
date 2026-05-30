import type { GitStatus } from "./state/types";
import { readGitStatus } from "./git-status";

export interface GitStatusCache {
  get(repoPath: string): GitStatus;
  invalidate(repoPath: string): void;
}

export function createGitStatusCache(opts: {
  readStatus?: (repoPath: string) => GitStatus;
  ttlMs?: number;
  now?: () => number;
} = {}): GitStatusCache {
  const readStatus = opts.readStatus ?? readGitStatus;
  const ttlMs = opts.ttlMs ?? 15_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: GitStatus; at: number }>();
  return {
    get(repoPath: string): GitStatus {
      const hit = cache.get(repoPath);
      const t = now();
      if (hit && t - hit.at < ttlMs) return hit.value;
      const value = readStatus(repoPath);
      cache.set(repoPath, { value, at: t });
      return value;
    },
    invalidate(repoPath: string): void {
      cache.delete(repoPath);
    },
  };
}
