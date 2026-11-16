// Test-only Q bootstrap: real API/stores, fictional state and no worker/runtime.
// The parent owns process supervision, ports, browser and contained cleanup.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { serve } from "@hono/node-server";
import { createApp, type AppDependencies } from "../../dashboard/src/server/index";
import { createOrganizationService } from "../../dashboard/src/server/organization-service";
import { createIssueService } from "../../dashboard/src/server/issue-service";
import { createOperatingViewService } from "../../dashboard/src/server/operating-view-service";
import { emptyProjectProfile } from "../../lib/portfolio-profile";
import { mutateClientPortfolio } from "../../lib/state/client-portfolio";
import { mutateIssueDocument, readIssueDocument } from "../../lib/state/issues";
import { upsertProjectProfile } from "../../lib/state/portfolio-profiles";
import { writeTask } from "../../lib/state/store";
import type { IssueCreateInput, IssueEvidenceReference, ReviewCandidate } from "../../lib/issues/types";
import type { SignalFeed } from "../../lib/signals/types";

assert.equal(process.env.NODE_ENV, "test", "fixture requires test mode");
assert.equal(process.env.SURTEC_OPERATING_VIEWS_SMOKE, "1", "fixture requires its explicit smoke flag");
assert.ok(process.env.SURTEC_FIXTURE_ROOT, "fixture root is required");
const suppliedRoot = resolve(process.env.SURTEC_FIXTURE_ROOT);
assert.equal(lstatSync(suppliedRoot).isSymbolicLink(), false, "fixture root cannot be redirected");
const root = realpathSync(suppliedRoot), relativeRoot = relative(realpathSync(tmpdir()), root);
assert.ok(relativeRoot && relativeRoot !== ".." && !relativeRoot.startsWith(`..${sep}`) && !isAbsolute(relativeRoot)
  && basename(root).startsWith("surtec-local-dashboard-"), "fixture requires its owned OS-temp root");
assert.equal(resolve(process.env.SURTEC_STATE_DIR ?? ""), join(root, "state"));
assert.equal(resolve(process.env.SURTEC_PROJECTS_ROOT ?? ""), join(root, "projects"));
assert.equal(realpathSync(process.cwd()), join(root, "runtime"), "fixture must run from its copied runtime");
for (const path of [join(root, "projects"), join(root, "runtime"), join(root, "state")]) {
  if (existsSync(path)) assert.equal(lstatSync(path).isSymbolicLink(), false, "fixture directory cannot be redirected");
}
const forbiddenRuntime = join(root, "forbidden-runtime");
assert.equal(process.env.SURTEC_CODEX_BIN, forbiddenRuntime);
assert.equal(existsSync(forbiddenRuntime), false, "real runtime entry must remain absent");

const fixedNow = "2026-10-16T12:00:00.000Z", clock = () => new Date(fixedNow);
const forbidden = (): never => {
  writeFileSync(join(root, "forbidden-effect"), "Unexpected fixture effect", { encoding: "utf8", mode: 0o600 });
  throw new Error("Synthetic effect refused");
};
const organization = createOrganizationService({ clock });
const issues = createIssueService(root, { now: clock, projectIds: () => ["alpha", "beta"], createTask: forbidden });
const titles = {
  delivery: "Public delivery issue", personal: "Public personal experiment", dependency: "Public dependency issue",
  blocked: "Public blocked decision", accepted: "Public exact-candidate fixture", objective: "Public operating outcome",
};
const taskId = "T-q-recorded", commitmentId = "commitment-delivery";

if (!existsSync(join(root, "initialized"))) {
  organization.saveCompany({ schema_version: 1, id: "surtec", display_name: "Public operating fixture",
    mission: "Inspect independent local evidence without granting authority", operating_principles: ["Preserve explicit human gates"],
    active_objective_ids: [], last_reviewed_at: null });
  const objective = organization.createObjective({ title: titles.objective, desired_outcome: "Keep fictional daily evidence traceable",
    success_criteria: ["Independent facts retain provenance", "No observation grants execution"], status: "active", horizon: "quarter",
    priority: 3, target_date: null, parent_objective_id: null });
  organization.setProjectObjectives("alpha", [objective.id], objective.id);
  organization.saveCompany({ ...organization.read().company, active_objective_ids: [objective.id] });
  mutateClientPortfolio(document => {
    document.clients["client-delivery"] = { id: "client-delivery", display_name: "Public fixture client", status: "active",
      criticality: "low", sla_note: null, next_review_date: null, confidential_notes: "SYNTHETIC_PRIVATE_CLIENT_NOTES",
      created_at: fixedNow, updated_at: fixedNow };
    document.commitments[commitmentId] = { id: commitmentId, project_id: "alpha", client_id: "client-delivery",
      title: "Public completed milestone", expected_outcome: "Inspect independently recorded delivery facts", due_date: null,
      priority: 3, criticality: "low", state: "completed", issue_numbers: [], pull_request_numbers: [], task_ids: [], session_ids: [],
      next_action: "Inspect existing evidence without inferring delivery", created_at: fixedNow, updated_at: fixedNow };
  });
  upsertProjectProfile({ ...emptyProjectProfile("alpha"), kind: "client-product", client_id: "client-delivery", last_reviewed_at: "2026-10-16" });
  // Deliberately unreviewed and unaligned; optional client/release facts are absent.
  upsertProjectProfile({ ...emptyProjectProfile("beta"), kind: "experiment" });
  const expected = "Inspect a fictional result", criteria = ["Result remains inspectable"];
  const input: IssueCreateInput = { project_id: "alpha", objective_id: objective.id, title: titles.delivery,
    expected_outcome: expected, acceptance_criteria: criteria, related_commitment_ids: [commitmentId],
    authorized_scope: { expected_outcome: expected, acceptance_criteria: criteria, allowed_path_patterns: ["src/**"],
      excluded_path_patterns: [], allowed_change_categories: ["ui"], explicit_exclusions: [] } };
  const delivery = issues.create(input);
  issues.create({ ...input, project_id: "beta", objective_id: null, title: titles.personal, related_commitment_ids: [] });
  const dependency = issues.create({ ...input, title: titles.dependency, related_commitment_ids: [] });
  const blocked = issues.create({ ...input, title: titles.blocked, blocked_by_issue_ids: [dependency.id], related_commitment_ids: [],
    next_action: "Review the unresolved fictional dependency" });
  const accepted = issues.create({ ...input, title: titles.accepted, related_commitment_ids: [] });
  writeTask({ envelope: { id: taskId, source: "dashboard", project: "alpha", task_type: "analysis", agent: "backend-engineer",
    title: "Public recorded task", instructions: "SYNTHETIC_PRIVATE_TASK_BODY", repo_path: join(root, "projects", "alpha"),
    branch: "main", sandbox: "read-only", expected_outputs: [], requires_human_approval: true, metadata: { issue_id: accepted.id } },
    lifecycle: "finished", outcome: "completed", created_at: fixedNow, started_at: fixedNow, updated_at: fixedNow,
    finished_at: fixedNow, result: null, logs_path: null });
  mutateIssueDocument(document => {
    // Historical Done without any candidate is intentionally not technical acceptance.
    document.issues[delivery.id]!.status = "done";
    document.issues[blocked.id]!.status = "needs-decision";
    const item = document.issues[accepted.id]!, id = `C-${randomUUID()}`;
    item.status = "done"; item.task_ids = [taskId]; item.candidate_ids = [id];
    // These are synthetic saved references, not a real runtime receipt or Git observation.
    const candidate: ReviewCandidate = { schema_version: 1, id, issue_id: item.id, task_id: taskId, execution_id: "run-q-recorded",
      repository_id: "alpha", base_revision: "a".repeat(40), candidate_revision: "b".repeat(40), diff_fingerprint: "c".repeat(64),
      changed_paths: ["src/fixture.ts"], scope_revision: item.scope_revision, created_at: fixedNow, invalidated_at: null };
    document.candidates[id] = candidate;
    for (const kind of ["verification", "review"] as const) {
      const evidenceId = `E-${randomUUID()}`;
      const evidence: IssueEvidenceReference = { schema_version: 1, id: evidenceId, issue_id: item.id, task_id: taskId,
        execution_id: candidate.execution_id, candidate_id: id, candidate_revision: candidate.candidate_revision,
        diff_fingerprint: candidate.diff_fingerprint, scope_revision: item.scope_revision, kind,
        label: `Synthetic exact ${kind} reference`, reference: `/api/tasks/${taskId}`, status: "passed", created_at: fixedNow };
      document.evidence[evidenceId] = evidence; item.evidence_ids.push(evidenceId);
    }
  });
  writeFileSync(join(root, "initialized"), "Owned fictional Q state; no worker/model/provider", { encoding: "utf8", mode: 0o600, flag: "wx" });
}

const document = readIssueDocument(), saved = Object.values(document.issues);
const issueId = (title: string) => { const matches = saved.filter(item => item.title === title); assert.equal(matches.length, 1); return matches[0]!.id; };
const objective = organization.read().objectives.find(item => item.title === titles.objective);
assert.ok(objective, "fixture objective is required");
const facts = { deliveryIssueId: issueId(titles.delivery), personalIssueId: issueId(titles.personal), blockedIssueId: issueId(titles.blocked),
  objectiveId: objective.id, commitmentId, fixedNow, acceptedIssueId: issueId(titles.accepted),
  acceptedCandidateId: document.issues[issueId(titles.accepted)]!.candidate_ids[0]!, taskId };
const feed: SignalFeed = { schema_version: 1, observed_at: fixedNow, pinned_signal_ids: [], warnings: [], signals: [
  { schema_version: 1, id: "sig_q_recorded_task", project_id: "alpha", project_kind: "client-product", source: "task",
    type: "synthetic-observation", severity: "info", title: "Public operating recommendation", reason: "Inspect recorded evidence",
    evidence_at: fixedNow, observed_at: fixedNow, suggested_action: "Inspect without authorizing execution", action_kind: "review-evidence",
    ranking: { tier: "unfinished-work", order: 1 }, state: "open", snoozed_until: null,
    evidence: { task_id: taskId, primary_objective_id: objective.id } },
] };
// A fictional cached adapter exercises stale/partial evidence. It is not a
// provider refresh or a production saved-feed adapter.
const dependencies = { organization, issues, operating: createOperatingViewService(root, { clock, readers: { signals: () => ({
  availability: "available", reason: "coverage-incomplete", origin: "saved", observed_at: "2026-10-14T12:00:00.000Z",
  fresh_until: "2026-10-15T12:00:00.000Z", complete: false,
  items: [{ id: "sig_q_cached", label: "Public stale partial observation", state: "open", project_id: "alpha", issue_id: facts.acceptedIssueId }],
}) } }),
  context: { roles: () => [], preview: forbidden },
  integrations: { read: async (projectId: string) => ({ schema_version: 2, project_id: projectId, observed_at: fixedNow, trace_id: null,
    source_control: { provider: "git", configured: false, health: "unconfigured", branch: null, dirty: null, uncommitted: null, ahead: null,
      behind: null, remote: { provider: "github", configured: false, health: "unconfigured", pull_requests: null, issues: null } },
    ci: { provider: "github-actions", configured: false, health: "unconfigured", status: null, branch: null },
    dependencies: { provider: "npm", configured: false, health: "unconfigured", outdated: null, observed_at: fixedNow }, deployments: [] }), invalidate: forbidden },
  signals: { read: async () => feed, act: forbidden }, inbox: async () => ({ items: [], repos: [] }),
} as unknown as AppDependencies;
const app = createApp(root, forbidden as never, { list: () => [], start: forbidden, stop: forbidden, get: forbidden } as never, undefined, dependencies);
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
server.on("listening", () => process.send?.({ type: "ready", port: (server.address() as { port: number }).port, facts }));

// Narrow child-only IPC, never a product HTTP endpoint or caller-selected path.
// A scenario retains the exact bytes present immediately before it; restoring
// does not run a migration, reconstruct records or erase real state.
let pendingSnapshot: { path: string; bytes: Buffer | null } | null = null;
function restore(): void {
  if (!pendingSnapshot) return;
  const { path, bytes } = pendingSnapshot;
  if (bytes === null) { if (existsSync(path)) unlinkSync(path); }
  else writeFileSync(path, bytes, { mode: 0o600 });
  pendingSnapshot = null;
}
function scenario(name: string): void {
  if (name === "restore") { restore(); return; }
  assert.equal(pendingSnapshot, null, "restore the current scenario before another");
  const path = join(root, "state", name === "degraded" ? "workflows/workflows.json" : "issues/issues.json");
  pendingSnapshot = { path, bytes: existsSync(path) ? readFileSync(path) : null };
  if (name === "degraded") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ schema_version: 99 }), { mode: 0o600 });
  } else if (name === "future-delivery") {
    const value = JSON.parse(readFileSync(path, "utf8")) as { evidence: Record<string, { issue_id: string; delivery_observation?: { schema_version: number } }> };
    const entry = Object.values(value.evidence).find(item => item.issue_id === facts.deliveryIssueId && item.delivery_observation);
    assert.ok(entry?.delivery_observation, "record a manual observation before testing future facets");
    entry.delivery_observation.schema_version = 99;
    writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  } else {
    assert.equal(name, "overflow");
    mutateIssueDocument(value => {
      const issue = value.issues[facts.deliveryIssueId]!;
      let count = issue.evidence_ids.filter(id => Object.hasOwn(value.evidence[id]!, "delivery_observation")).length;
      while (count++ < 64) {
        const id = `E-${randomUUID()}`;
        value.evidence[id] = { schema_version: 1, id, issue_id: issue.id, task_id: null, execution_id: null, candidate_id: null,
          candidate_revision: null, diff_fingerprint: null, scope_revision: issue.scope_revision, kind: "work-product",
          label: "Operator delivery observation", reference: `/api/work-issues/${issue.id}`, status: "informational", created_at: fixedNow,
          delivery_observation: { schema_version: 1, kind: "follow-up-recorded", origin: "operator-entered", commitment_id: commitmentId,
            occurred_at: "2026-10-15T12:00:00.000Z", summary: "SYNTHETIC_PRIVATE_CAPACITY_FACT", source_reference: "synthetic-capacity",
            next_action: "SYNTHETIC_PRIVATE_CAPACITY_NEXT" } };
        issue.evidence_ids.push(id);
      }
    });
  }
}
let stopping = false;
const stop = () => { if (stopping) return; stopping = true; server.close(() => process.exit(0)); };
process.on("message", (message: unknown) => {
  if (message === "stop") { stop(); return; }
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const input = message as Record<string, unknown>, id = input.id;
  if (!Number.isSafeInteger(id) || (id as number) < 1) return;
  if (Object.keys(input).length !== 3 || input.type !== "scenario" || !["degraded", "future-delivery", "overflow", "restore"].includes(input.scenario as string)) {
    process.send?.({ type: "scenario-result", id, ok: false, reason: "invalid-fixture-command" }); return;
  }
  try { scenario(input.scenario as string); process.send?.({ type: "scenario-result", id, ok: true }); }
  catch { process.send?.({ type: "scenario-result", id, ok: false, reason: "scenario-refused" }); }
});
process.once("SIGINT", stop); process.once("SIGTERM", stop); process.once("disconnect", stop);
