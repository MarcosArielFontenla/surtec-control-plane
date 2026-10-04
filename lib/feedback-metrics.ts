import type { Signal, SignalHumanRecord, SignalSource } from "./signals/types";
import type { TaskRecord, WorkSession } from "./state/types";

const DAY_MS = 24 * 60 * 60 * 1000;

export const SIGNAL_FRESHNESS_DAYS: Record<SignalSource, number> = {
  git: 14,
  github: 7,
  ci: 1,
  deployment: 7,
  issue: 7,
  task: 7,
  profile: 30,
  note: 14,
  session: 7,
  commitment: 30,
  objective: 30,
  harness: 30,
};

export interface FeedbackMetrics {
  schema_version: 1;
  generated_at: string;
  recommendations: {
    actions_recorded: number;
    accepted: number;
    snoozed: number;
    dismissed: number;
    pinned: number;
    median_evidence_to_action_ms: number | null;
    latency_samples: number;
  };
  tasks: {
    total: number;
    terminal: number;
    completed: number;
    retried: number;
    needs_review: number;
    success_rate: number | null;
    retry_rate: number | null;
    needs_review_rate: number | null;
  };
  verification: {
    passed: number;
    failed: number;
    skipped: number;
    missing: number;
    eligible: number;
    pass_rate: number | null;
  };
  work_sessions: {
    total: number;
    completed: number;
    closed: number;
    completed_with_next_action: number;
    next_action_captured: number;
    completion_rate: number | null;
    next_action_capture_rate: number | null;
  };
  signals: {
    freshness_eligible: number;
    stale: number;
    stale_rate: number | null;
  };
}
export interface FeedbackMetricsInput {
  signalActions: SignalHumanRecord[];
  signals: Signal[];
  tasks: TaskRecord[];
  workSessions: WorkSession[];
  now?: Date;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle] : Math.round((ordered[middle - 1] + ordered[middle]) / 2);
}

export function buildFeedbackMetrics(input: FeedbackMetricsInput): FeedbackMetrics {
  const now = input.now ?? new Date();
  const actionRecords = input.signalActions.filter((record) => record.first_action);
  const accepted = actionRecords.filter((record) => record.first_action === "acknowledge" || record.first_action === "resolve").length;
  const snoozed = actionRecords.filter((record) => record.first_action === "snooze").length;
  const dismissed = actionRecords.filter((record) => record.first_action === "dismiss").length;
  const pinned = actionRecords.filter((record) => record.first_action === "pin-for-today").length;
  const latencyMs = actionRecords.flatMap((record) => {
    const evidence = parseTimestamp(record.signal_evidence_at);
    const action = parseTimestamp(record.first_action_at);
    return evidence !== null && action !== null && action >= evidence ? [action - evidence] : [];
  });

  const terminalTasks = input.tasks.filter((task) => task.lifecycle === "finished" && (task.outcome ?? task.result?.status));
  const taskOutcome = (task: TaskRecord) => task.outcome ?? task.result?.status ?? null;
  const completed = terminalTasks.filter((task) => taskOutcome(task) === "completed").length;
  const retried = input.tasks.filter((task) => (task.orchestration?.attempts ?? 0) > 1).length;
  const needsReview = terminalTasks.filter((task) => taskOutcome(task) === "needs-review").length;

  const verificationCounts = { passed: 0, failed: 0, skipped: 0, missing: 0 };
  for (const task of terminalTasks) {
    const status = task.result?.verification?.status;
    if (status === "passed") verificationCounts.passed += 1;
    else if (status === "failed") verificationCounts.failed += 1;
    else if (status === "skipped") verificationCounts.skipped += 1;
    else verificationCounts.missing += 1;
  }
  const verificationEligible = verificationCounts.passed + verificationCounts.failed;

  const completedSessions = input.workSessions.filter((session) => session.status === "completed");
  const closedSessions = input.workSessions.filter((session) => session.status !== "active");
  const sessionsWithNextAction = closedSessions.filter((session) => Boolean(session.next_action?.trim()));
  const completedWithNextAction = completedSessions.filter((session) => Boolean(session.next_action?.trim())).length;

  let staleSignals = 0;
  let freshnessEligible = 0;
  for (const signal of input.signals) {
    const evidence = parseTimestamp(signal.evidence_at);
    if (evidence === null) continue;
    freshnessEligible += 1;
    const threshold = (SIGNAL_FRESHNESS_DAYS[signal.source] ?? 7) * DAY_MS;
    if (Math.max(0, now.getTime() - evidence) > threshold) staleSignals += 1;
  }

  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    recommendations: {
      actions_recorded: actionRecords.length,
      accepted,
      snoozed,
      dismissed,
      pinned,
      median_evidence_to_action_ms: median(latencyMs),
      latency_samples: latencyMs.length,
    },
    tasks: {
      total: input.tasks.length,
      terminal: terminalTasks.length,
      completed,
      retried,
      needs_review: needsReview,
      success_rate: rate(completed, terminalTasks.length),
      retry_rate: rate(retried, input.tasks.length),
      needs_review_rate: rate(needsReview, terminalTasks.length),
    },
    verification: {
      ...verificationCounts,
      eligible: verificationEligible,
      pass_rate: rate(verificationCounts.passed, verificationEligible),
    },
    work_sessions: {
      total: input.workSessions.length,
      completed: completedSessions.length,
      closed: closedSessions.length,
      completed_with_next_action: completedWithNextAction,
      next_action_captured: sessionsWithNextAction.length,
      completion_rate: rate(completedSessions.length, input.workSessions.length),
      next_action_capture_rate: rate(sessionsWithNextAction.length, closedSessions.length),
    },
    signals: {
      freshness_eligible: freshnessEligible,
      stale: staleSignals,
      stale_rate: rate(staleSignals, freshnessEligible),
    },
  };
}
