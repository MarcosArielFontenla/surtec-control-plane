import { createHash } from "node:crypto";
import type { InboxItem, TaskRecord, GitStatus } from "../state/types";
import type { Note } from "../state/notes";
import type { ProjectProfile } from "../portfolio-profile";
import type { ProjectIntegrationsSnapshot } from "../integrations/types";
import { redactText } from "../security/redaction";
import type { Signal, SignalRankingTier, SignalSource } from "./types";

export interface SignalProjectEvidence {
  id: string;
  status: string;
  git: GitStatus | null;
  profile: ProjectProfile | null;
  profile_available?: boolean;
  integrations: ProjectIntegrationsSnapshot | null;
  last_activity_at: string | null;
  notes: Note[];
}

export interface SignalWorkSessionEvidence {
  id: string;
  project_id: string;
  status: "active" | "paused" | "closed";
  next_action: string | null;
  updated_at: string;
}

export interface SignalEvidenceSnapshot {
  projects: SignalProjectEvidence[];
  tasks: TaskRecord[];
  issues: InboxItem[];
  sessions?: SignalWorkSessionEvidence[];
  warnings?: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_ISSUE_DAYS = 7;
const RECENT_ACTIVITY_DAYS = 7;
const STALE_REVIEW_DAYS = 30;
const STALE_NOTE_DAYS = 14;
const LONG_RUNNING_CI_MS = 60 * 60 * 1000;
const MAX_TEXT = 240;
const MAX_SIGNAL_COUNT = 5000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

interface CandidateInput {
  projectId: string;
  source: SignalSource;
  type: string;
  occurrence: string;
  severity: Signal["severity"];
  title: string;
  reason: string;
  evidenceAt: string;
  suggestedAction: string;
  actionKind: string;
  tier: SignalRankingTier;
  evidence: Record<string, unknown>;
}

function safeText(value: string): string {
  return redactText(value).replace(/[\r\n\t]+/g, " ").slice(0, MAX_TEXT);
}

function safeTimestamp(value: string | null | undefined, fallback: string): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;
}

function safeBranch(value: string | null | undefined): string | null {
  return value ? safeText(value).slice(0, 500) : null;
}

function safeId(value: string): boolean {
  return SAFE_ID.test(value) && !value.includes("..");
}

function stableId(input: CandidateInput): string {
  const seed = [input.projectId, input.source, input.type, input.occurrence].join("\u0000");
  return `sig_${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

function dateOrdinal(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day);
}

function elapsedDays(then: string | null | undefined, now: Date): number | null {
  if (!then || !Number.isFinite(Date.parse(then))) return null;
  return Math.max(0, Math.floor((now.getTime() - Date.parse(then)) / DAY_MS));
}

function deadlineDays(deadline: string, now: Date): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(deadline);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = dateOrdinal(year, month, day);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return Math.floor((timestamp - dateOrdinal(now.getFullYear(), now.getMonth() + 1, now.getDate())) / DAY_MS);
}

function localMidnight(deadline: string): string {
  const [year, month, day] = deadline.split("-").map(Number);
  const value = new Date(0);
  value.setFullYear(year, month - 1, day);
  value.setHours(0, 0, 0, 0);
  return value.toISOString();
}

function rankFor(tier: SignalRankingTier): number {
  return ({
    "production-failure": 1,
    "client-commitment": 2,
    "blocked-work": 3,
    "imminent-deadline": 4,
    "unfinished-work": 5,
    maintenance: 6,
    hygiene: 7,
  })[tier];
}

function candidate(input: CandidateInput, observedAt: string): Signal {
  return {
    schema_version: 1,
    id: stableId(input),
    project_id: input.projectId,
    source: input.source,
    type: input.type,
    severity: input.severity,
    title: safeText(input.title),
    reason: safeText(input.reason),
    evidence_at: safeTimestamp(input.evidenceAt, observedAt),
    observed_at: observedAt,
    suggested_action: safeText(input.suggestedAction),
    action_kind: input.actionKind,
    ranking: { tier: input.tier, order: rankFor(input.tier) },
    state: "open",
    snoozed_until: null,
    evidence: Object.fromEntries(Object.entries(input.evidence).filter(([, value]) => value !== undefined)),
  };
}

function projectCandidates(project: SignalProjectEvidence, now: Date, observedAt: string): Signal[] {
  const out: Signal[] = [];
  const profile = project.profile;
  const criticality = profile?.criticality ?? "medium";
  const projectId = project.id;
  const integrations = project.integrations;
  const sourceControl = integrations?.source_control;
  const git = project.git?.ok ? project.git : (sourceControl?.configured ? {
    branch: sourceControl.branch,
    dirty: sourceControl.dirty ?? false,
    uncommitted: sourceControl.uncommitted ?? 0,
    ahead: sourceControl.ahead ?? 0,
    behind: sourceControl.behind ?? 0,
    last_commit: null,
    ok: sourceControl.health === "ok",
  } : project.git);

  for (const deployment of integrations?.deployments ?? []) {
    if (deployment.health !== "down" && deployment.health !== "degraded") continue;
    const down = deployment.health === "down";
    const highCriticality = criticality === "high";
    const type = down ? "deployment-down" : "deployment-degraded";
    out.push(candidate({
      projectId,
      source: "deployment",
      type,
      occurrence: `${deployment.provider}:${deployment.deployed_at ?? "current"}:${deployment.health}`,
      severity: down || highCriticality ? "critical" : "warning",
      title: down ? "Deployment is down" : "Deployment is degraded",
      reason: `${deployment.provider} reports ${deployment.health}${deployment.http_status === null ? "" : ` (HTTP ${deployment.http_status})`}.`,
      evidenceAt: deployment.observed_at,
      suggestedAction: "Inspect the deployment health and the latest release.",
      actionKind: "inspect-deployment",
      tier: down || highCriticality ? "production-failure" : "maintenance",
      evidence: {
        provider: deployment.provider,
        health: deployment.health,
        http_status: deployment.http_status,
        deployed_at: deployment.deployed_at,
      },
    }, observedAt));
  }

  const ci = integrations?.ci;
  const ciUpdatedAt = ci?.run_updated_at ? safeTimestamp(ci.run_updated_at, observedAt) : undefined;
  if (ci?.status === "failing") {
    out.push(candidate({
      projectId,
      source: "ci",
      type: "ci-failing",
      occurrence: `${ci.branch ?? "unknown"}:failing:${ci.run_id ?? "current"}`,
      severity: criticality === "high" ? "critical" : "warning",
      title: "Continuous integration is failing",
      reason: `The latest observed CI run on ${safeBranch(ci.branch) ?? "the configured branch"} failed.`,
      evidenceAt: ciUpdatedAt ?? integrations?.observed_at ?? observedAt,
      suggestedAction: "Review the failing CI run before continuing the release.",
      actionKind: "review-ci",
      tier: criticality === "high" ? "production-failure" : "blocked-work",
      evidence: { branch: safeBranch(ci.branch), status: ci.status, run_id: ci.run_id, run_updated_at: ciUpdatedAt },
    }, observedAt));
  } else if (ci?.status === "running" && ci.run_started_at) {
    const duration = now.getTime() - Date.parse(ci.run_started_at);
    if (Number.isFinite(duration) && duration >= LONG_RUNNING_CI_MS) {
      const minutes = Math.floor(duration / 60_000);
      out.push(candidate({
        projectId,
        source: "ci",
        type: "ci-running-long",
        occurrence: `${ci.branch ?? "unknown"}:${ci.run_id ?? ci.run_started_at}`,
        severity: "warning",
        title: "CI has been running unusually long",
        reason: `The CI run on ${safeBranch(ci.branch) ?? "the configured branch"} has been running for ${minutes} minutes (threshold: 60).`,
        evidenceAt: ci.run_started_at,
        suggestedAction: "Check whether the CI run is progressing or stuck.",
        actionKind: "review-ci",
        tier: "maintenance",
        evidence: { branch: safeBranch(ci.branch), status: ci.status, run_started_at: safeTimestamp(ci.run_started_at, observedAt), run_id: ci.run_id, run_updated_at: ciUpdatedAt, duration_minutes: minutes },
      }, observedAt));
    }
  }

  if (git?.dirty || (git?.uncommitted ?? 0) > 0) {
    const changed = Math.max(git?.uncommitted ?? 0, git?.dirty ? 1 : 0);
    out.push(candidate({
      projectId,
      source: "git",
      type: "working-tree-dirty",
      occurrence: `${git?.branch ?? "unknown"}:${changed}`,
      severity: "info",
      title: "Working tree has uncommitted changes",
      reason: `Branch ${safeBranch(git?.branch) ?? "unknown"} has ${changed} uncommitted change${changed === 1 ? "" : "s"}.`,
        evidenceAt: observedAt,
      suggestedAction: "Review, commit, or deliberately discard the local changes.",
      actionKind: "review-working-tree",
      tier: "hygiene",
      evidence: { branch: safeBranch(git?.branch), dirty: true, uncommitted: changed },
    }, observedAt));
  }
  if ((git?.ahead ?? 0) > 0) {
    out.push(candidate({
      projectId,
      source: "git",
      type: "branch-ahead",
      occurrence: `${git?.branch ?? "unknown"}:${git?.ahead}`,
      severity: "info",
      title: "Branch has unpublished commits",
      reason: `Branch ${safeBranch(git?.branch) ?? "unknown"} is ${git?.ahead} commit${git?.ahead === 1 ? "" : "s"} ahead of its upstream.`,
      evidenceAt: observedAt,
      suggestedAction: "Review the commits and publish them when ready.",
      actionKind: "review-branch",
      tier: "hygiene",
      evidence: { branch: safeBranch(git?.branch), ahead: git?.ahead },
    }, observedAt));
  }
  if ((git?.behind ?? 0) > 0) {
    out.push(candidate({
      projectId,
      source: "git",
      type: "branch-behind",
      occurrence: `${git?.branch ?? "unknown"}:${git?.behind}`,
      severity: "warning",
      title: "Branch is behind its upstream",
      reason: `Branch ${safeBranch(git?.branch) ?? "unknown"} is ${git?.behind} commit${git?.behind === 1 ? "" : "s"} behind its upstream.`,
      evidenceAt: observedAt,
      suggestedAction: "Review upstream changes before synchronizing the branch.",
      actionKind: "review-branch",
      tier: "maintenance",
      evidence: { branch: safeBranch(git?.branch), behind: git?.behind },
    }, observedAt));
  }

  for (const pullRequest of integrations?.source_control.remote.waiting_pull_requests ?? []) {
    if (pullRequest.review_decision !== "CHANGES_REQUESTED" && pullRequest.review_decision !== "REVIEW_REQUIRED") continue;
    if (!Number.isInteger(pullRequest.number) || pullRequest.number < 1) continue;
    const authorAction = pullRequest.review_decision === "CHANGES_REQUESTED";
    out.push(candidate({
      projectId,
      source: "github",
      type: authorAction ? "pull-request-changes-requested" : "pull-request-review-pending",
      occurrence: `pr:${pullRequest.number}:${pullRequest.review_decision}:${pullRequest.updated_at}`,
      severity: authorAction ? "warning" : "info",
      title: authorAction ? `Pull request #${pullRequest.number} needs changes` : `Pull request #${pullRequest.number} is waiting for review`,
      reason: `Open pull request #${pullRequest.number} has review decision ${pullRequest.review_decision}.`,
      evidenceAt: pullRequest.updated_at,
      suggestedAction: authorAction ? "Review the requested changes and update the pull request." : "Check whether a review is due or needs to be requested.",
      actionKind: "review-pull-request",
      tier: "blocked-work",
      evidence: { pull_request_number: pullRequest.number, review_decision: pullRequest.review_decision, updated_at: safeTimestamp(pullRequest.updated_at, observedAt) },
    }, observedAt));
  }

  const deadline = profile?.deadline;
  if (deadline) {
    const days = deadlineDays(deadline, now);
    if (days !== null && days <= 7) {
      const overdue = days < 0;
      const clientCommitment = profile?.kind === "client" && overdue;
      out.push(candidate({
        projectId,
        source: "profile",
        type: overdue ? "deadline-overdue" : "deadline-approaching",
        occurrence: deadline,
        severity: overdue && (profile?.priority ?? 5) <= 2 ? "critical" : "warning",
        title: overdue ? "Project deadline is overdue" : "Project deadline is approaching",
        reason: overdue ? `The recorded deadline ${deadline} passed ${Math.abs(days)} day${days === -1 ? "" : "s"} ago.` : `The recorded deadline is ${deadline}, in ${days} day${days === 1 ? "" : "s"}.`,
        evidenceAt: localMidnight(deadline),
        suggestedAction: "Review the commitment and update its next action or deadline.",
        actionKind: "review-deadline",
        tier: clientCommitment ? "client-commitment" : overdue ? "blocked-work" : "imminent-deadline",
        evidence: { deadline, days_remaining: days, kind: profile?.kind ?? "personal", priority: profile?.priority ?? 3 },
      }, observedAt));
    }
  }

  const active = profile?.lifecycle === "active" || (!profile && project.status === "active");
  if (active) {
    const inactiveDays = elapsedDays(project.last_activity_at, now);
    if (inactiveDays === null || inactiveDays >= RECENT_ACTIVITY_DAYS) {
      out.push(candidate({
        projectId,
        source: "profile",
        type: "active-project-stale",
        occurrence: "active",
        severity: inactiveDays !== null && inactiveDays >= STALE_REVIEW_DAYS ? "warning" : "info",
        title: "Active project has no recent activity",
        reason: inactiveDays === null ? "No project task or Git commit activity is currently available." : `The latest task or Git commit activity was ${inactiveDays} days ago (recent activity threshold: 7 days).`,
        evidenceAt: project.last_activity_at ?? observedAt,
        suggestedAction: "Confirm whether this project is still active and record its next action.",
        actionKind: "review-project",
        tier: "maintenance",
        evidence: { last_activity_at: project.last_activity_at, inactive_days: inactiveDays },
      }, observedAt));
    }
  }

  const lifecycle = profile?.lifecycle ?? project.status;
  const pausedOrArchived = lifecycle === "archived" || lifecycle === "paused";
  if (project.profile_available !== false && !pausedOrArchived) {
    if (!profile?.current_goal) {
      out.push(candidate({
        projectId, source: "profile", type: "missing-current-goal", occurrence: "current_goal",
        severity: "info", title: "Project has no current goal", reason: "The local project profile has no current goal recorded.",
        evidenceAt: observedAt, suggestedAction: "Record the outcome this project is currently working toward.", actionKind: "edit-project-profile",
        tier: "hygiene", evidence: { field: "current_goal", profile_exists: Boolean(profile) },
      }, observedAt));
    }
    if (!profile?.next_action) {
      out.push(candidate({
        projectId, source: "profile", type: "missing-next-action", occurrence: "next_action",
        severity: "info", title: "Project has no next action", reason: "The local project profile has no next action recorded.",
        evidenceAt: observedAt, suggestedAction: "Record the smallest concrete step that moves this project forward.", actionKind: "edit-project-profile",
        tier: "hygiene", evidence: { field: "next_action", profile_exists: Boolean(profile) },
      }, observedAt));
    }
    const reviewedDays = elapsedDays(profile?.last_reviewed_at, now);
    if (reviewedDays === null || reviewedDays >= STALE_REVIEW_DAYS) {
      out.push(candidate({
        projectId, source: "profile", type: "project-review-stale", occurrence: "review",
        severity: "info", title: "Project profile review is stale",
        reason: reviewedDays === null ? "The local project profile has not been reviewed." : `The local project profile was last reviewed ${reviewedDays} days ago (stale after 30 days).`,
        evidenceAt: profile?.last_reviewed_at ?? observedAt,
        suggestedAction: "Review the project's goal, priority, criticality, deadline, and next action.", actionKind: "review-project-profile",
        tier: "maintenance", evidence: { last_reviewed_at: profile?.last_reviewed_at ?? null, days_since_review: reviewedDays },
      }, observedAt));
    }
  }

  for (const note of pausedOrArchived ? [] : project.notes) {
    if (note.done || !safeId(note.id)) continue;
    const age = elapsedDays(note.created_at, now);
    if (age === null || age < STALE_NOTE_DAYS) continue;
    out.push(candidate({
      projectId, source: "note", type: "unresolved-project-note", occurrence: note.id,
      severity: "info", title: "An unresolved project note is aging",
      reason: `An unresolved note created ${age} days ago is still open (review threshold: 14 days).`,
      evidenceAt: note.created_at, suggestedAction: "Review the note and mark it complete or convert it into a next action.", actionKind: "review-project-note",
      tier: "hygiene", evidence: { note_id: note.id.slice(0, 100), created_at: safeTimestamp(note.created_at, observedAt), age_days: age },
    }, observedAt));
  }
  return out;
}

function taskCandidates(tasks: TaskRecord[], observedAt: string): Signal[] {
  const out: Signal[] = [];
  for (const task of tasks) {
    if (task.decision?.status === "approved" || task.decision?.status === "rejected") continue;
    const projectId = task.envelope.project;
    const taskId = task.envelope.id;
    const attempts = task.orchestration?.attempts ?? 0;
    const updatedAt = safeTimestamp(task.updated_at, observedAt);
    let type: string | null = null;
    let title = "";
    let reason = "";
    let severity: Signal["severity"] = "warning";
    let actionKind = "review-task";

    if (task.outcome === "blocked" || (task.lifecycle !== "finished" && (task.result?.blockers.length ?? 0) > 0)) {
      type = "task-blocked"; title = "Task is blocked"; reason = "A task is blocked and needs attention."; actionKind = "resolve-task-blocker";
    } else if (task.lifecycle === "finished" && task.outcome === "failed") {
      type = "task-failed"; title = "Task failed"; reason = "A task finished with outcome failed.";
    } else if (task.lifecycle === "finished" && task.outcome === "needs-review") {
      type = "task-needs-review"; title = "Task needs review"; reason = "A finished task is marked needs-review."; actionKind = "review-task-result";
    } else if (task.lifecycle === "finished" && (task.outcome === "completed" || task.outcome === "partial") && task.envelope.requires_human_approval) {
      type = "task-awaiting-approval"; title = "Task is waiting for human approval"; reason = "A task requiring human approval finished without a recorded decision."; actionKind = "review-task-approval";
    }
    if (!type) continue;

    out.push(candidate({
      projectId, source: "task", type, occurrence: `${taskId}:${attempts}`, severity,
      title, reason, evidenceAt: updatedAt,
      suggestedAction: type === "task-blocked" ? "Inspect the blocker and decide the next safe step." : "Review the task result and record any required decision.",
      actionKind,
      tier: type === "task-blocked" || type === "task-awaiting-approval" || type === "task-needs-review" ? "blocked-work" : "unfinished-work",
      evidence: { task_id: taskId, attempts, outcome: task.outcome, lifecycle: task.lifecycle, requires_human_approval: task.envelope.requires_human_approval, updated_at: updatedAt },
    }, observedAt));
  }
  return out;
}

function issueCandidates(issues: InboxItem[], now: Date, observedAt: string): Signal[] {
  const out: Signal[] = [];
  for (const issue of issues) {
    if (!safeId(issue.projectId) || !Number.isInteger(issue.number) || issue.number < 1) continue;
    const highLabel = issue.labels.find((label) => /^(?:priority[: _-]*)?(?:critical|urgent|high|p0|p1|1)$/i.test(label.trim()));
    const age = elapsedDays(issue.updatedAt, now);
    if (!highLabel || age === null || age > RECENT_ISSUE_DAYS) continue;
    const priorityLabel = highLabel.trim().toLowerCase().replace(/^priority[: _-]*/, "");
    out.push(candidate({
      projectId: issue.projectId,
      source: "issue",
      type: "high-priority-issue-recent",
      occurrence: `issue:${issue.number}:${issue.updatedAt}`,
      severity: /critical|urgent|p0/i.test(priorityLabel) ? "critical" : "warning",
      title: `High-priority issue #${issue.number} was updated recently`,
      reason: `Issue #${issue.number} has priority label “${priorityLabel}” and was updated ${age} day${age === 1 ? "" : "s"} ago.`,
      evidenceAt: issue.updatedAt,
      suggestedAction: "Review the issue and confirm whether it changes the project's next action.",
      actionKind: "review-issue",
      tier: "blocked-work",
      evidence: { issue_number: issue.number, priority_label: priorityLabel, updated_at: safeTimestamp(issue.updatedAt, observedAt), age_days: age },
    }, observedAt));
  }
  return out;
}

function sessionCandidates(sessions: SignalWorkSessionEvidence[], observedAt: string): Signal[] {
  return sessions
    .filter((session) => safeId(session.project_id) && safeId(session.id) && session.status === "paused" && Boolean(session.next_action))
    .map((session) => candidate({
      projectId: session.project_id,
      source: "session",
      type: "paused-session-next-action",
      occurrence: session.id,
      severity: "info",
      title: "Paused work session has a next action",
      reason: "A paused work session has a defined next action ready to resume.",
      evidenceAt: session.updated_at,
      suggestedAction: "Resume the paused work session when ready.",
      actionKind: "resume-session",
      tier: "unfinished-work",
      evidence: { session_id: session.id, updated_at: safeTimestamp(session.updated_at, observedAt) },
    }, observedAt));
}

function compareSignals(left: Signal, right: Signal): number {
  return left.ranking.order - right.ranking.order
    || severityWeight(right.severity) - severityWeight(left.severity)
    || left.evidence_at.localeCompare(right.evidence_at)
    || left.project_id.localeCompare(right.project_id)
    || left.id.localeCompare(right.id);
}

function severityWeight(value: Signal["severity"]): number {
  return value === "critical" ? 3 : value === "warning" ? 2 : 1;
}

export function generateSignals(evidence: SignalEvidenceSnapshot, clock: Date = new Date()): Signal[] {
  const now = new Date(clock);
  const observedAt = now.toISOString();
  return [
    ...evidence.projects.filter((project) => safeId(project.id)).flatMap((project) => projectCandidates(project, now, observedAt)),
    ...taskCandidates(evidence.tasks.filter((task) => safeId(task.envelope.project) && safeId(task.envelope.id)), observedAt),
    ...issueCandidates(evidence.issues, now, observedAt),
    ...sessionCandidates(evidence.sessions ?? [], observedAt),
  ].sort(compareSignals).slice(0, MAX_SIGNAL_COUNT);
}
