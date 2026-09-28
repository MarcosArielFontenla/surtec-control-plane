// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProjectIntegrationsSnapshot } from "../../../../lib/integrations/types";
import type { ProjectProfile } from "../../../../lib/portfolio-profile";
import type { OverviewModel, TodayModel } from "../../../../lib/state/types";
import type { SignalFeed } from "../../../../lib/signals/types";
import * as api from "../api";
import { ProjectDetailView } from "./ProjectDetailView";

const observedAt = "2026-09-27T12:00:00.000Z";
const project = {
  id: "alpha", status: "active", health: null, note: null, repo: "https://github.com/owner/alpha.git",
  path: "/private/alpha", configured: true, git: null, last_activity: null,
  task_counts: { inProgress: 1, finished: 1 },
};
const overview: OverviewModel = {
  projects: [project],
  inProgress: [{ id: "task-active", project: "alpha", agent: "backend-engineer", title: "Active fictional task", lifecycle: "running", outcome: null,
    updated_at: observedAt, finished_at: null, requires_human_approval: false, attempts: 1, max_attempts: 3, retry_at: null, cancel_requested_at: null }],
  history: [{ id: "task-recent", project: "alpha", agent: "qa-reviewer", title: "Recent fictional task", lifecycle: "finished", outcome: "completed",
    updated_at: observedAt, finished_at: observedAt, requires_human_approval: false, attempts: 1, max_attempts: 3, retry_at: null, cancel_requested_at: null }],
  attention: [],
};
const today: TodayModel = {
  date: "2026-09-27", time_zone: "America/Buenos_Aires", generated_at: observedAt,
  active: overview.inProgress, attention: [], completed: [], failed: [], cancelled: [], retries: [], cancellations: [], recoveries: [],
  counts: { active: 1, attention: 0, completed: 0, failed: 0, cancelled: 0, retries: 0 }, warnings: [],
  portfolio: { signal_status: "available", signals_observed_at: observedAt, recommendations: [], critical_attention: [], work_to_continue: [],
    client_commitments: [], personal_opportunities: [], stale_profiles: [], snoozed_signals: [], pinned_signal_ids: [], warnings: [],
    sessions: { available: true, unavailable_reason: null, active: [], paused: [], completed: [] } },
};
const profile: ProjectProfile = {
  schema_version: 2, project_id: "alpha", kind: "client-product", lifecycle: "active", priority: 1, criticality: "high",
  current_goal: "Deliver the fictional release", next_action: "Review synthetic rollout", deadline: null,
  client_id: "private-client-reference", last_reviewed_at: null, tags: [],
};
function integrations(overrides: Partial<ProjectIntegrationsSnapshot> = {}): ProjectIntegrationsSnapshot {
  return {
    schema_version: 2, project_id: "alpha", observed_at: observedAt, trace_id: null,
    source_control: { provider: "git", configured: true, health: "ok", branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0,
      remote: { provider: "github", configured: true, health: "ok", pull_requests: 2, issues: 3,
        waiting_pull_requests: [{ number: 7, updated_at: observedAt, review_decision: "REVIEW_REQUIRED" }] } },
    ci: { provider: "github-actions", configured: true, health: "ok", status: "passing", branch: "main", run_id: "123" },
    dependencies: { provider: "npm", configured: true, health: "ok", outdated: 0, observed_at: observedAt },
    deployments: [{ provider: "railway", configured: true, health: "ok", status: "success", observed_at: observedAt,
      url: "https://alpha.example.test", http_status: null, latency_ms: null, deployed_at: observedAt }],
    ...overrides,
  };
}

function renderDetail(snapshot = integrations()) {
  vi.spyOn(api, "getProjectIntegrations").mockResolvedValue(snapshot);
  vi.spyOn(api, "getSignals").mockResolvedValue({ schema_version: 1, observed_at: observedAt, pinned_signal_ids: [], warnings: [], signals: [] } satisfies SignalFeed);
  vi.spyOn(api, "getActivity").mockResolvedValue({ items: [
    { kind: "commit", at: observedAt, project: "alpha", hash: "abc123", subject: "Synthetic commit", author: "Fictional Author" },
  ] });
  vi.spyOn(api, "getNotes").mockResolvedValue({ notes: [] });
  const onPrepareTask = vi.fn();
  render(<ProjectDetailView project={project} overview={overview} today={today} profile={profile} profileReady profileLoading={false}
    onProfileSaved={() => {}} onBack={() => {}} onOpenTask={() => {}} onPrepareTask={onPrepareTask} />);
  return { onPrepareTask };
}

describe("ProjectDetailView", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders the aggregate evidence, tasks, notes, signals state section and keeps client references private", async () => {
    renderDetail();
    await screen.findByText("Control de código");
    expect(screen.getByText("2 PR abiertas · 3 issues abiertas")).toBeTruthy();
    expect(screen.getByRole("link", { name: /PR #7/ }).getAttribute("href")).toBe("https://github.com/owner/alpha/pull/7");
    expect(screen.getByText("Al día")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Abrir proveedor" }).some((link) => link.getAttribute("href") === "https://github.com/owner/alpha/issues")).toBe(true);
    expect(screen.getByText("Deliver the fictional release")).toBeTruthy();
    expect(screen.getByText("Active fictional task")).toBeTruthy();
    expect(screen.getByText("Recent fictional task")).toBeTruthy();
    expect(screen.getByText("Synthetic commit")).toBeTruthy();
    expect(screen.getByText("Notas locales")).toBeTruthy();
    expect(screen.getByText("No hay sesiones activas o pausadas para este proyecto.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("private-client-reference");
    expect(screen.getAllByTitle(observedAt).length).toBeGreaterThan(0);
  });

  it("keeps the project detail usable when optional providers are degraded and refreshes the aggregate", async () => {
    const degraded = integrations({
      source_control: { ...integrations().source_control, remote: { ...integrations().source_control.remote, health: "unknown", error: "GitHub unavailable", pull_requests: null, issues: null } },
      ci: { ...integrations().ci, health: "unknown", status: "unknown", error: "CI unavailable" },
      deployments: [{ ...integrations().deployments[0]!, health: "unknown", status: null, url: null, error: "health check unavailable" }],
      dependencies: { ...integrations().dependencies, health: "unknown", error: "n/a (npm install)" },
    });
    const spy = vi.spyOn(api, "getProjectIntegrations").mockResolvedValueOnce(degraded).mockResolvedValueOnce(integrations({ observed_at: "2026-09-27T12:01:00.000Z" }));
    vi.spyOn(api, "getSignals").mockResolvedValue({ schema_version: 1, observed_at: observedAt, pinned_signal_ids: [], warnings: [], signals: [] });
    vi.spyOn(api, "getActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "getNotes").mockResolvedValue({ notes: [] });
    render(<ProjectDetailView project={project} overview={overview} today={today} profile={profile} profileReady profileLoading={false}
      onProfileSaved={() => {}} onBack={() => {}} onOpenTask={() => {}} onPrepareTask={() => {}} />);

    await screen.findByText("GitHub unavailable");
    expect(screen.getByText("Active fictional task")).toBeTruthy();
    expect(screen.getByText("Recent fictional task")).toBeTruthy();
    expect(screen.getByText("CI unavailable")).toBeTruthy();
    expect(screen.getByText("health check unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith("alpha", true));
    await waitFor(() => expect(screen.getAllByTitle("2026-09-27T12:01:00.000Z").length).toBeGreaterThan(0));
  });

  it("omits client profile details from task prefill and does not dispatch", async () => {
    const createTask = vi.spyOn(api, "createTask");
    const { onPrepareTask } = renderDetail();
    fireEvent.click(screen.getByRole("button", { name: /Preparar tarea/ }));
    expect(onPrepareTask).toHaveBeenCalledWith("alpha", "Review the project and determine the next safe action. Client context is omitted; choose any categories explicitly in the task form.");
    expect(createTask).not.toHaveBeenCalled();
  });
});
