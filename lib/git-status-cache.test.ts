import { describe, it, expect, vi } from "vitest";
import { createGitStatusCache } from "./git-status-cache";
import type { GitStatus } from "./state/types";

const sample = (branch: string): GitStatus => ({
  branch, dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true,
});

describe("createGitStatusCache", () => {
  it("reuses the cached value within the TTL", () => {
    let t = 1000;
    const readStatus = vi.fn(() => sample("main"));
    const cache = createGitStatusCache({ readStatus, ttlMs: 100, now: () => t });
    cache.get("/r"); t = 1050; cache.get("/r");
    expect(readStatus).toHaveBeenCalledTimes(1);
  });
  it("recomputes after the TTL expires", () => {
    let t = 1000;
    const readStatus = vi.fn(() => sample("main"));
    const cache = createGitStatusCache({ readStatus, ttlMs: 100, now: () => t });
    cache.get("/r"); t = 1200; cache.get("/r");
    expect(readStatus).toHaveBeenCalledTimes(2);
  });
  it("caches per path independently", () => {
    const readStatus = vi.fn((p: string) => sample(p));
    const cache = createGitStatusCache({ readStatus, ttlMs: 100, now: () => 0 });
    expect(cache.get("/a").branch).toBe("/a");
    expect(cache.get("/b").branch).toBe("/b");
    expect(readStatus).toHaveBeenCalledTimes(2);
  });
  it("invalidate forces a fresh read on the next get", () => {
    let calls = 0;
    const status = { branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true };
    const cache = createGitStatusCache({ readStatus: () => { calls += 1; return status; }, ttlMs: 100_000, now: () => 0 });
    cache.get("/p");           // calls = 1 (fresh read)
    cache.get("/p");           // calls = 1 (cached; within TTL)
    cache.invalidate("/p");
    cache.get("/p");           // calls = 2 (re-read after invalidate)
    expect(calls).toBe(2);
  });
});
