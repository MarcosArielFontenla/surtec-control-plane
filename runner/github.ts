import { spawnSync } from "node:child_process";
import type { AgentResult, TaskEnvelope } from "../lib/state/types";

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
    { cwd: sourceRepo, encoding: "utf8", timeout: 30_000 },
  );
  if (r.status === 0) return { url: (r.stdout ?? "").trim() };
  const err = (r.stderr ?? "") || (r.stdout ?? "") || (r.error ? r.error.message : "");
  return { error: err.trim() };
}
