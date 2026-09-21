import { spawnSync } from "node:child_process";
import type { AgentResult, TaskEnvelope } from "../lib/state/types";
import { gitEnvironment } from "../lib/security/environment";
import { redactText } from "../lib/security/redaction";

export function buildPrBody(envelope: TaskEnvelope, result: AgentResult | null): string {
  const lines: string[] = [];
  lines.push("## Summary", result?.summary?.trim() || "(no summary)", "");
  if (result && result.risks.length > 0) {
    lines.push("## Risks", ...result.risks.map((r) => `- ${r}`), "");
  }
  if (result && result.next_steps.length > 0) {
    lines.push("## Next steps", ...result.next_steps.map((s) => `- ${s}`), "");
  }
  lines.push("---", `Dispatched by Surtec Control Plane · task ${envelope.id} · agent ${envelope.agent}`);
  return lines.join("\n");
}

export function openPullRequest(
  sourceRepo: string,
  branch: string,
  base: string,
  title: string,
  body: string,
): { url?: string; error?: string } {
  const r = spawnSync(
    "gh",
    ["pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body],
    { cwd: sourceRepo, encoding: "utf8", timeout: 30_000, env: gitEnvironment() },
  );
  if (r.status === 0) return { url: (r.stdout ?? "").trim() };
  const err = (r.stderr ?? "") || (r.stdout ?? "") || (r.error ? r.error.message : "");
  return { error: redactText(err.trim()) };
}

export function ensurePullRequest(
  sourceRepo: string,
  branch: string,
  base: string,
  title: string,
  body: string,
): { url?: string; error?: string } {
  const existing = spawnSync(
    "gh",
    ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url"],
    { cwd: sourceRepo, encoding: "utf8", timeout: 30_000, env: gitEnvironment() },
  );
  if (existing.status !== 0) {
    const error = (existing.stderr ?? "") || (existing.stdout ?? "") || (existing.error ? existing.error.message : "");
    return { error: redactText(error.trim() || "gh pr list failed") };
  }
  const existingUrl = existing.status === 0 ? (existing.stdout ?? "").trim() : "";
  if (existingUrl) return { url: existingUrl };
  return openPullRequest(sourceRepo, branch, base, title, body);
}
