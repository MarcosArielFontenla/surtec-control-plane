import { spawnSync } from "node:child_process";
import type { VerificationReport, VerificationCheck } from "../lib/state/types";
import { projectCommandEnvironment } from "../lib/security/environment";
import { redactText } from "../lib/security/redaction";

const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_CHARS = 4000;

// Runs the given commands IN ORDER in the worktree, fail-fast. Commands come from the
// trusted registry (never agent input), so shell:true is acceptable and resolves
// pnpm/pnpm.cmd cross-platform. Never throws — a spawn failure is recorded as a failed check.
export function runVerification(worktreePath: string, commands: string[]): VerificationReport {
  if (commands.length === 0) return { status: "skipped", checks: [] };
  const checks: VerificationCheck[] = [];
  for (const command of commands) {
    const r = spawnSync(command, {
      cwd: worktreePath,
      shell: true,
      encoding: "utf8",
      timeout: VERIFY_TIMEOUT_MS,
      env: projectCommandEnvironment(),
    });
    const ok = r.status === 0 && !r.error;
    const combined = redactText((r.stdout ?? "") + (r.stderr ?? "") + (r.error ? r.error.message : ""));
    checks.push({ command: redactText(command), ok, output_tail: combined.slice(-TAIL_CHARS) });
    if (!ok) return { status: "failed", checks };
  }
  return { status: "passed", checks };
}
