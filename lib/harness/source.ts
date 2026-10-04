import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { assertManifest, assertSourceRegistry } from "./validation";
import type { HarnessSource } from "./types";

export const hash = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
export function safeRelative(path: string): boolean {
  return path.length > 0 && path.length <= 240 && !isAbsolute(path) && !path.includes("\\")
    && !path.includes(":") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

// Never traverse links, including intermediate directories. Inspection does not execute file content.
export function readContained(root: string, path: string, limit = 256 * 1024): Buffer | null {
  if (!safeRelative(path)) throw new Error("unsafe relative entry");
  const base = realpathSync(root);
  let candidate = base;
  for (const part of path.split("/")) {
    candidate = join(candidate, part);
    let stat;
    try { stat = lstatSync(candidate); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("entry unavailable");
    }
    if (stat.isSymbolicLink()) throw new Error("linked entry rejected");
  }
  const stat = lstatSync(candidate);
  const relation = relative(base, realpathSync(candidate));
  if (relation.startsWith("..") || isAbsolute(relation) || !stat.isFile() || stat.size > limit) throw new Error("entry rejected by read boundary");
  const bytes = readFileSync(candidate);
  if (bytes.length > limit) throw new Error("entry size limit exceeded");
  return bytes;
}

export function loadHarnessSource(repoRoot: string): HarnessSource {
  try {
    const bytes = readContained(repoRoot, "registry/harness-sources.yml");
    if (!bytes) return { status: "unknown", manifest: null, registry: null, fingerprint: null, reason: "Canonical source is not configured." };
    const registry: unknown = parse(bytes.toString("utf8"));
    assertSourceRegistry(registry);
    const manifestBytes = readContained(repoRoot, registry.source.manifest);
    if (!manifestBytes || hash(manifestBytes) !== registry.source.manifest_sha256) throw new Error("canonical manifest fingerprint changed");
    const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
    assertManifest(manifest);
    if (manifest.source_id !== registry.source.id) throw new Error("canonical source identity mismatch");
    if (registry.source.root !== "." && !safeRelative(registry.source.root)) throw new Error("unsafe canonical root");
    const sourceRoot = registry.source.root === "." ? repoRoot : resolve(repoRoot, registry.source.root);
    // Root directories must also not be redirected through links.
    if (registry.source.root !== ".") {
      let current = repoRoot;
      for (const part of registry.source.root.split("/")) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error("linked source root"); }
    }
    for (const entry of manifest.expected_entries) {
      const observed = readContained(sourceRoot, entry.path);
      if (!observed || hash(observed) !== entry.sha256) throw new Error("canonical baseline changed or missing");
    }
    return { status: "trusted", manifest, registry, fingerprint: hash(Buffer.concat([bytes, Buffer.from("\n"), manifestBytes])), reason: null };
  } catch {
    return { status: "unknown", manifest: null, registry: null, fingerprint: null, reason: "Canonical source is unavailable, invalid or changed; review the trusted registry before comparing." };
  }
}
