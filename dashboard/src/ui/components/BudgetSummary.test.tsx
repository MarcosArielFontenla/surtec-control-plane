// @vitest-environment jsdom
import { once } from "node:events";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { TextEncoder as NodeTextEncoder } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { serve } from "@hono/node-server";
import { chromium, type Browser } from "playwright";
import type { ViteDevServer } from "vite";
import { BUDGET_DIMENSIONS, type BudgetAmounts, type BudgetLedger, type BudgetLimits, type BudgetPolicy, type BudgetPolicyBinding } from "../../../../lib/budgets/types";
import type { ContextManifest } from "../../../../lib/context/types";
import type { IssueLineage, WorkIssue } from "../../../../lib/issues/types";
import type { OrganizationSnapshot } from "../../../../lib/organization";
import type { WorkflowRoleId } from "../../../../lib/workflows/types";
import type { ClientContextCategory } from "../../../../lib/client-portfolio";
import { readBudgetPolicy } from "../../../../lib/budgets/policy";
import { assertBudgetLedger } from "../../../../lib/budgets/validation";
import { createBudgetService, existingBudgetConstraint, type BudgetPreview } from "../../server/budget-service";
import { createApp, type AppDependencies } from "../../server/index";
import { createHttpSecurity } from "../../server/http-security";
import { createRoutineService, type BudgetReadView } from "../../server/routine-service";
import { budgetStatePath } from "../../../../lib/state/paths";
import type { ProcessManager } from "../../../../runner/process-manager";
import * as api from "../api";
import { BudgetSummary } from "./BudgetSummary";

const at = new Date(Date.now() - 60000).toISOString(), hash = "a".repeat(64);
const amount = (values: Partial<BudgetAmounts> = {}): BudgetAmounts => ({ attempts: 0, runtime_ms: 0, total_tokens: 0, concurrent_reads: 0,
  concurrent_writes: 0, review_attempts: 0, review_runtime_ms: 0, review_total_tokens: 0, corrections: 0, ...values });
const caps = amount({ attempts: 2, runtime_ms: 1000, total_tokens: 100, concurrent_reads: 1 });
function limits(values: Partial<BudgetAmounts>): BudgetLimits {
  return Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, values[dimension] === undefined
    ? { status: "unconfigured" } : { status: "configured", hard_cap: values[dimension] }])) as BudgetLimits;
}
function policy(): BudgetPolicy {
  return { schema_version: 1, revision: 7, pricing: { status: "unavailable", reason: "no-versioned-source" }, rules: [
    { id: "company-rule", revision: 3, scope: { kind: "company", id: "surtec" }, period: "none", warning_percent: 80, limits: limits(caps) },
  ] };
}
const emptyLedger = (): BudgetLedger => ({ schema_version: 1, revision: 5, created_at: at, updated_at: at,
  subjects: {}, reservations: {}, admission_intents: {}, charges: {} });
function preview(): BudgetPreview {
  return structuredClone(createBudgetService("synthetic", { clock: () => new Date(at), readBudgetPolicy: () => ({ policy: policy(), fingerprint: hash }),
    readBudgetLedger: emptyLedger }).preview({ attribution: { company_id: "surtec", objective_ids: [], project_ids: ["alpha"], issue_id: null,
      role_id: "planner", execution_id: "synthetic-execution" }, base_caps: caps }));
}
function readView(): BudgetReadView {
  const value = preview();
  return { schema_version: 1, observed_at: at, status: value.status, executable: false, reserves_capacity: false,
    ledger: value.ledger, policy: { revision: 7, fingerprint: hash }, sources: value.resolution!.sources.filter((source) => source.kind === "policy"),
    pricing: { status: "unavailable", reason: "no-versioned-source" }, denials: [] };
}
function deferred<T>() {
  let finish!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((resolve, fail) => { finish = resolve; reject = fail; }); return { promise, finish, reject };
}
beforeEach(() => { vi.spyOn(api, "fetchBudgets").mockRejectedValue(new Error("Unexpected synthetic budget read")); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("BudgetSummary conservative evidence", () => {
  it("shows finite effective caps, attributable counters, source identity and no execution authority", () => {
    render(<BudgetSummary budget={preview()} />);
    const region = screen.getByRole("region", { name: "Presupuesto de recursos" });
    expect(region).toHaveTextContent("Disponibilidad informativa: disponible");
    expect(region).toHaveTextContent("no reserva capacidad ni concede permiso de ejecución");
    expect(region).toHaveTextContent("policy:company-rule"); expect(region).toHaveTextContent(hash);
    expect(region).toHaveTextContent("Tokens"); expect(region).toHaveTextContent("restante 100");
    expect(region).toHaveTextContent("Revisión"); expect(region).toHaveTextContent("Correcciones");
    expect(region).toHaveTextContent("sin fuente de precios versionada");
    expect(api.fetchBudgets).not.toHaveBeenCalled(); expect(within(region).queryByRole("button")).toBeNull();
  });

  it.each([undefined, null])("keeps absent additive preview %s unavailable without an ambient fetch", (value) => {
    render(<BudgetSummary budget={value} />);
    expect(screen.getByRole("region", { name: "Presupuesto de recursos" })).toHaveTextContent("Presupuesto no disponible");
    expect(api.fetchBudgets).not.toHaveBeenCalled(); expect(screen.queryByText(/informativa: disponible/)).toBeNull();
  });

  it.each(["version", "null ledger", "null resolution", "invalid flags", "missing dimensions", "fractional", "negative", "nonfinite", "array"])(
    "fails closed for %s preview data without exposing private raw fields", (kind) => {
      const value = preview() as unknown as Record<string, unknown>;
      value.private_raw = "Synthetic confidential source";
      if (kind === "version") value.schema_version = 999;
      if (kind === "null ledger") value.ledger = null;
      if (kind === "null resolution") value.resolution = null;
      if (kind === "invalid flags") value.executable = true;
      if (kind === "missing dimensions") delete ((value.resolution as BudgetPreview["resolution"])!.sources[0]!.dimensions as unknown as Record<string, unknown>).attempts;
      if (["fractional", "negative", "nonfinite"].includes(kind)) (value.resolution as BudgetPreview["resolution"])!.sources[0]!.dimensions.attempts.consumed = kind === "fractional" ? .5 : kind === "negative" ? -1 : NaN;
      render(<BudgetSummary budget={(kind === "array" ? [] : value) as never} />);
      expect(screen.queryByText(/informativa: disponible/)).toBeNull();
      expect(document.body.textContent).not.toContain("Synthetic confidential source");
      expect(document.body.textContent).toMatch(/no disponible|desconocido/);
    });

  it.each(["absent", "unavailable", "future observed", "future ledger", "invalid observed", "missing observed"])(
    "does not infer known availability from %s despite optimistic can_admit", (kind) => {
      const value = preview(); value.can_admit = true; value.status = "available";
      if (kind === "absent" || kind === "unavailable") value.ledger = { status: kind, revision: null, updated_at: null };
      if (kind === "future observed") value.observed_at = "2999-01-01T00:00:00.000Z";
      if (kind === "future ledger") value.ledger.updated_at = "2999-01-01T00:00:00.000Z";
      if (kind === "invalid observed") value.observed_at = "2026-02-31T00:00:00Z";
      if (kind === "missing observed") value.observed_at = null;
      render(<BudgetSummary budget={value} />);
      expect(screen.queryByText(/informativa: disponible/)).toBeNull();
      expect(document.body.textContent).toMatch(/no disponible|desconocido/);
      expect(document.body.textContent).not.toContain("restante 100");
    });

  it("distinguishes a configured zero hard limit from unconfigured and never invents unlimited availability", () => {
    const config = policy(); config.rules[0]!.limits = limits({ attempts: 0 });
    const value = createBudgetService("synthetic", { clock: () => new Date(at), readBudgetPolicy: () => ({ policy: config, fingerprint: hash }),
      readBudgetLedger: emptyLedger }).preview({ attribution: { company_id: "surtec", objective_ids: [], project_ids: ["alpha"], issue_id: null,
      role_id: "planner", execution_id: "synthetic-execution" }, base_caps: caps });
    render(<BudgetSummary budget={value} />);
    expect(document.body.textContent).toContain("límite 0"); expect(document.body.textContent).toContain("no configurado");
    expect(document.body.textContent).toContain("informativa: agotada"); expect(document.body.textContent).not.toMatch(/ilimitad|infinity|∞/i);
  });

  it("retains unknown high-water and holds while showing exact denials, UTC buckets, warnings and fingerprints", () => {
    const value = preview(), source = value.resolution!.sources[0]!;
    source.period = "utc-day"; source.bucket = at.slice(0, 10);
    source.dimensions.total_tokens = { status: "configured", cap: 100, proven_consumed: 20, consumed: null, reserved: 50, remaining: null, warning: true };
    value.status = "unavailable"; value.can_admit = false;
    value.denials = [{ code: "budget-accounting-unavailable", dimension: "total_tokens", source_ids: [source.id] }];
    render(<BudgetSummary budget={value} />);
    const region = screen.getByRole("region", { name: "Presupuesto de recursos" });
    expect(region).toHaveTextContent("consumido desconocido"); expect(region).toHaveTextContent("probado 20");
    expect(region).toHaveTextContent("reservado 50"); expect(region).toHaveTextContent("restante desconocido");
    for (const label of screen.getAllByText("Tokens", { exact: true })) expect(label.nextElementSibling).not.toHaveTextContent(/restante 100\b/);
    expect(region).toHaveTextContent("budget-accounting-unavailable"); expect(region).toHaveTextContent("Tokens");
    expect(region).toHaveTextContent("utc-day"); expect(region).toHaveTextContent(at.slice(0, 10)); expect(region).toHaveTextContent(hash);
    expect(region).toHaveTextContent(/advertencia|umbral|aviso/i);
  });

  it("does not sum overlapping company and project consumption or review/correction labels", () => {
    const value = preview(), source = value.resolution!.sources[0]!;
    source.dimensions.total_tokens = { ...source.dimensions.total_tokens, consumed: 20, proven_consumed: 20, reserved: 50, remaining: 30 };
    value.resolution!.sources = [source, { ...structuredClone(source), id: "policy:project-rule", scope: { kind: "project", id: "alpha" } }];
    render(<BudgetSummary budget={value} />);
    expect(document.body.textContent).toContain("policy:company-rule"); expect(document.body.textContent).toContain("policy:project-rule");
    expect(document.body.textContent).not.toContain("consumido 40"); expect(document.body.textContent).not.toContain("reservado 100");
    expect(document.body.textContent).toMatch(/no se suman|no sumar|superponen/i);
  });

  it.each(["overflow", "remaining exceeds zero cap", "resolved unavailable", "effective remaining exceeds source"])(
    "downgrades %s arithmetic without converting preserved static caps into known availability", (kind) => {
      const value = preview(), source = value.resolution!.sources[0]!, dimension = source.dimensions.attempts;
      value.status = "available"; value.can_admit = true;
      if (kind === "overflow") {
        Object.assign(dimension, { cap: Number.MAX_SAFE_INTEGER, consumed: Number.MAX_SAFE_INTEGER, proven_consumed: Number.MAX_SAFE_INTEGER,
          reserved: Number.MAX_SAFE_INTEGER, remaining: 1 });
        value.resolution!.dimensions.attempts.remaining = 1;
      } else if (kind === "remaining exceeds zero cap") {
        Object.assign(dimension, { cap: 0, consumed: 0, proven_consumed: 0, reserved: 0, remaining: 1 });
        value.resolution!.dimensions.attempts.remaining = 1;
      } else if (kind === "resolved unavailable") {
        value.resolution!.dimensions.attempts.status = "unavailable";
        value.resolution!.dimensions.attempts.remaining = null;
      } else {
        Object.assign(dimension, { cap: 2, consumed: 2, proven_consumed: 2, reserved: 0, remaining: 0 });
        value.resolution!.dimensions.attempts.remaining = 1;
      }
      render(<BudgetSummary budget={value} />);
      expect(screen.queryByText("Disponibilidad informativa: disponible.")).toBeNull();
      const facts = screen.getAllByText("Intentos", { exact: true }).map((label) => label.nextElementSibling);
      expect(facts[0]).toHaveTextContent("límite 2 · restante desconocido");
      expect(facts[1]).toHaveTextContent(`límite ${dimension.cap}`);
      for (const fact of facts) expect(fact).not.toHaveTextContent(/restante 1\b/);
      expect(document.body.textContent).toContain(hash);
      expect(api.fetchBudgets).not.toHaveBeenCalled();
    });

  it("keeps independently measured existing availability known while its consumption and hold breakdown stay unknown", () => {
    const constraint = existingBudgetConstraint({ id: "workflow-synthetic", kind: "workflow", revision: 1, fingerprint: "b".repeat(64),
      caps, availability: { attempts: 1 } });
    const value = createBudgetService("synthetic", { clock: () => new Date(at), readBudgetPolicy: () => ({ policy: policy(), fingerprint: hash }),
      readBudgetLedger: emptyLedger }).preview({ attribution: { company_id: "surtec", objective_ids: [], project_ids: ["alpha"], issue_id: null,
      role_id: "planner", execution_id: "synthetic-execution" }, base_caps: caps, constraints: [constraint] });
    const existing = value.resolution!.sources.find((source) => source.id === `existing:${constraint.id}`)!;
    expect(existing.dimensions.attempts).toMatchObject({ consumed: null, remaining: 1 });
    render(<BudgetSummary budget={value} />);
    expect(screen.getByText("Disponibilidad informativa: disponible.")).toBeInTheDocument();
    const sources = screen.getByText(/Fuentes y consumo/).parentElement!, source = within(sources).getByText(/existing:workflow-synthetic/).parentElement!;
    const fact = within(source).getByText("Intentos", { exact: true }).nextElementSibling;
    expect(fact).toHaveTextContent("consumido desconocido · probado desconocido · reservado desconocido · restante 1");
    expect(screen.getAllByText("Intentos", { exact: true })[0]!.nextElementSibling).toHaveTextContent("límite 2 · restante 1");
    expect(api.fetchBudgets).not.toHaveBeenCalled();
  });

  it("bounds malformed optional provenance and never renders private errors, paths or credential-shaped fields", () => {
    const value = preview(); value.denials = [{ code: "budget-accounting-unavailable", source_ids: ["api_key=synthetic-sensitive-value C:\\private\\facts"] }];
    value.limitation = "Synthetic private limitation api_key=synthetic-sensitive-value";
    (value as unknown as Record<string, unknown>).rendered = "Synthetic private prompt";
    render(<BudgetSummary budget={value} />);
    expect(document.body.textContent).not.toContain("synthetic-sensitive-value"); expect(document.body.textContent).not.toContain("C:\\private");
    expect(document.body.textContent).not.toContain("Synthetic private prompt"); expect(document.body.textContent).not.toContain("Synthetic private limitation");
  });

  it("clips large source and denial lists explicitly while preserving independent server restrictions", () => {
    const value = preview(), source = value.resolution!.sources[0]!;
    value.resolution!.sources = Array.from({ length: 26 }, (_, index) => ({ ...structuredClone(source), id: `policy:source-${index}` }));
    value.denials = Array.from({ length: 26 }, (_, index) => ({ code: "budget-accounting-unavailable" as const, source_ids: [`source-${index}`] }));
    render(<BudgetSummary budget={value} />);
    expect(document.body.textContent).toContain("Fuentes y consumo (26)");
    expect(document.body.textContent).toContain("1 fuentes adicionales no desplegadas");
    expect(document.body.textContent).toContain("1 motivos adicionales");
    expect(document.body.textContent).toContain("policy:source-24"); expect(document.body.textContent).not.toContain("policy:source-25");
    expect(screen.queryByText(/informativa: disponible/)).toBeNull();
  });

  it.each(["alpha", "beta", "constructor", "..", ""]) ("never fetches while an explicit null budget is supplied with project %s", (projectId) => {
    render(<BudgetSummary budget={null} projectId={projectId} />);
    expect(api.fetchBudgets).not.toHaveBeenCalled(); expect(screen.getByText("Presupuesto no disponible.")).toBeInTheDocument();
  });

  it("refuses mismatched explicit project provenance without a replacement GET", () => {
    render(<BudgetSummary budget={preview()} projectId="beta" />);
    expect(screen.getByText("Presupuesto no disponible.")).toBeInTheDocument(); expect(api.fetchBudgets).not.toHaveBeenCalled();
  });
});

describe("BudgetSummary isolated project reads", () => {
  it.each(["constructor", "__proto__", "..", "alpha/secret", ""]) ("rejects invalid project %s without reading an ambient budget", (projectId) => {
    render(<BudgetSummary projectId={projectId} />); expect(api.fetchBudgets).not.toHaveBeenCalled();
    expect(screen.getByText("Presupuesto no disponible.")).toBeInTheDocument();
  });
  it("issues only the exact project GET and explicit refresh, with no implicit admission", async () => {
    vi.mocked(api.fetchBudgets).mockResolvedValue(readView());
    render(<BudgetSummary projectId="alpha" title="Presupuesto del proyecto" />);
    await screen.findByText("Disponibilidad informativa: disponible.");
    expect(api.fetchBudgets).toHaveBeenCalledExactlyOnceWith({ project_id: "alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Actualizar presupuesto" }));
    await waitFor(() => expect(api.fetchBudgets).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.fetchBudgets).mock.calls.every(([query]) => JSON.stringify(query) === JSON.stringify({ project_id: "alpha" }))).toBe(true);
  });

  it("hides prior balances during explicit refresh and refresh-key invalidation", async () => {
    const second = deferred<BudgetReadView>();
    vi.mocked(api.fetchBudgets).mockResolvedValueOnce(readView()).mockReturnValueOnce(second.promise);
    const view = render(<BudgetSummary projectId="alpha" refreshKey={1} />);
    await screen.findByText("Disponibilidad informativa: disponible."); view.rerender(<BudgetSummary projectId="alpha" refreshKey={2} />);
    expect(screen.queryByText("Disponibilidad informativa: disponible.")).toBeNull();
    expect(screen.getByText("Consultando presupuesto…")).toBeInTheDocument();
    await act(async () => second.finish(readView())); expect(screen.getByText("Disponibilidad informativa: disponible.")).toBeInTheDocument();
  });

  it("ignores late A -> B -> A responses and unmount completions", async () => {
    const first = deferred<BudgetReadView>(), second = deferred<BudgetReadView>(), third = deferred<BudgetReadView>(), fourth = deferred<BudgetReadView>();
    vi.mocked(api.fetchBudgets).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise).mockReturnValueOnce(fourth.promise);
    const view = render(<BudgetSummary projectId="alpha" />);
    view.rerender(<BudgetSummary projectId="beta" />); view.rerender(<BudgetSummary projectId="alpha" />);
    const stale = readView(); stale.policy!.revision = 99;
    await act(async () => { first.finish(stale); second.finish(stale); });
    expect(screen.queryByText("Disponibilidad informativa: disponible.")).toBeNull();
    await act(async () => third.finish(readView())); expect(screen.getByText("Disponibilidad informativa: disponible.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actualizar presupuesto" })); view.unmount();
    await act(async () => fourth.finish(stale)); expect(screen.queryByRole("region")).toBeNull();
  });

  it("isolates HTTP failure and never exposes its raw message or stale known balance", async () => {
    vi.mocked(api.fetchBudgets).mockRejectedValue(new Error("api_key=synthetic-sensitive-value C:\\private\\budget.json"));
    render(<><p>Existing detail remains visible</p><BudgetSummary projectId="alpha" /></>);
    await screen.findByText("No pude consultar el presupuesto; el resto de la vista sigue disponible.");
    expect(screen.getByText("Existing detail remains visible")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("synthetic-sensitive-value"); expect(document.body.textContent).not.toContain("C:\\private");
    expect(screen.queryByText("Disponibilidad informativa: disponible.")).toBeNull();
  });
});

function syntheticManifest(role: WorkflowRoleId, agent: string): ContextManifest {
  return { schema_version: 1, fingerprint: hash, project_id: "alpha", role_id: role, agent_id: agent, task_kind: "analysis", sandbox: "read-only",
    tools: ["inspect"], approval_rules: [], budget: { max_attempts: 1, max_runtime_ms: 1000, max_total_tokens: 100 },
    limits: { max_lines: 500, max_bytes: 60000, max_sources: 64 }, sources: [], selected_categories: [], excluded_categories: ["confidential-notes"],
    omitted_sources: [], total_lines: 0, total_bytes: 0,
    routing: { action: "direct", work_scale: "trivial", review_depth: "focused", qa_required: false, reasons: [],
      delegation: { admitted: false, executable: false, reasons: [] } },
    testing: { mode: "functional", minimum_review_depth: "focused", runner_ids: [], commands: [], reasons: [], requires_red_evidence: false } };
}
function syntheticIssue(): WorkIssue {
  return { schema_version: 1, id: "synthetic-budget-issue", project_id: "alpha", objective_id: null, parent_issue_id: null,
    title: "Inspect synthetic resource evidence", expected_outcome: "Keep the resource evidence attributable", acceptance_criteria: ["Unknown usage remains unknown"],
    status: "authorized", work_scale: "trivial", classification_inputs: { affected_domains: ["ui"], requires_migration: false, security_impact: false },
    classification_rationale: ["Narrow synthetic fixture"], plan: [], authorized_scope: { expected_outcome: "Keep the resource evidence attributable",
      acceptance_criteria: ["Unknown usage remains unknown"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [],
      allowed_change_categories: ["ui"], explicit_exclusions: [] }, scope_revision: 1, scope_changed_at: null,
    scope_change_approval_id: null, scope_change_proposal: null, priority: 50, criticality: "low", blocked_by_issue_ids: [], assigned_role_id: "backend-engineer",
    related_commitment_ids: [], external_references: [], next_action: null, task_ids: [], evidence_ids: [], candidate_ids: [], created_at: at, updated_at: at, revision: 3 };
}
function unknownLedger(fingerprint: string): BudgetLedger {
  const binding: BudgetPolicyBinding = { policy_id: "company-rule", policy_revision: 3, policy_fingerprint: fingerprint,
    scope: { kind: "company", id: "surtec" }, period: "none", bucket: "none", limits: policy().rules[0]!.limits };
  const value: BudgetLedger = { ...emptyLedger(), subjects: { "synthetic-subject": { id: "synthetic-subject", kind: "task", task_id: "synthetic-task",
    project_id: "alpha", role_id: "planner", agent_id: "tech-lead", issue_id: null, workflow: null,
    attribution: { company_id: "surtec", objective_ids: [], project_ids: ["alpha"], role_id: "planner", issue_id: null, execution_id: "synthetic-task" } } },
  reservations: { "synthetic-reservation": { id: "synthetic-reservation", revision: 2, subject_id: "synthetic-subject", intent_id: "synthetic-intent",
    status: "unknown", policy_bindings: [binding], held: amount({ runtime_ms: 500, total_tokens: 50, concurrent_reads: 1 }),
    uncertain_dimensions: ["runtime_ms", "total_tokens", "concurrent_reads"], run_ids: ["synthetic-run"], created_at: at, updated_at: at } },
  admission_intents: { "synthetic-intent": { id: "synthetic-intent", subject_id: "synthetic-subject", reservation_id: "synthetic-reservation",
    admission_id: "synthetic-admission", status: "unknown", created_at: at, updated_at: at } },
  charges: { "synthetic-charge": { id: "synthetic-charge", subject_id: "synthetic-subject", reservation_id: "synthetic-reservation", run_id: "synthetic-run",
    attempts: 1, runtime_ms: 100, observed_total_tokens: 20, runtime_state: "unknown", usage_state: "unknown", status: "terminal", review: false,
    correction: false, created_at: at, updated_at: at } } };
  assertBudgetLedger(value); return value;
}

it.runIf(process.env.SURTEC_BUDGET_SUMMARY_BROWSER_SMOKE === "1")("T013 renders the actual dashboard and API resource summaries with isolated immutable evidence across reload and restart", async () => {
  // The component suite uses jsdom's realm. Vite/esbuild must receive the
  // native typed-array realm paired with Node's encoder; load only on opt-in.
  vi.stubGlobal("Uint8Array", Object.getPrototypeOf(new NodeTextEncoder().encode("")).constructor);
  const { createServer: createViteServer } = await import("vite"), { default: react } = await import("@vitejs/plugin-react");
  const root = mkdtempSync(join(tmpdir(), "surtec-budget-summary-browser-")), state = join(root, "state"), projects = join(root, "projects");
  let server: ReturnType<typeof serve> | undefined, vite: ViteDevServer | undefined, browser: Browser | undefined;
  let browserClosed = false, viteClosed = false, apiClosed = false;
  const dispatch = vi.fn(), execute = vi.fn(() => { throw new Error("Synthetic resource reads must never execute"); });
  const processes = { start: execute, stop: execute, get: vi.fn(), list: vi.fn(() => []), subscribe: vi.fn() };
  try {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir())); expect(lstatSync(root).isSymbolicLink()).toBe(false);
    mkdirSync(projects); const project = join(projects, "alpha"); mkdirSync(project);
    execFileSync("git", ["-c", "core.hooksPath=", "init", "--initial-branch=main", project], { stdio: "ignore" });
    cpSync(resolve("registry"), join(root, "registry"), { recursive: true }); cpSync(resolve("schemas"), join(root, "schemas"), { recursive: true });
    writeFileSync(join(root, "registry", "projects.yml"), JSON.stringify({ projects: { alpha: { local_path: project,
      default_branch: "main", status: "active", allowed_agents: ["tech-lead", "backend-engineer"], sandbox: { default: "workspace-write" },
      commands: {}, approval: { before_merge: true, before_deploy: true } } } }));
    const policyBytes = JSON.stringify(policy()); writeFileSync(join(root, "registry", "budget-policy.yml"), policyBytes);
    const fingerprint = createHash("sha256").update(policyBytes).digest("hex"), ledgerPath = budgetStatePath(state);
    mkdirSync(dirname(ledgerPath), { recursive: true }); writeFileSync(ledgerPath, JSON.stringify(unknownLedger(fingerprint), null, 2));
    const before = { bytes: readFileSync(ledgerPath), modified: lstatSync(ledgerPath).mtimeMs };
    vi.stubEnv("SURTEC_STATE_DIR", state); vi.stubEnv("SURTEC_PROJECTS_ROOT", projects);
    const organization: OrganizationSnapshot = { company: { schema_version: 1, id: "surtec", display_name: "Synthetic company", mission: "Inspect synthetic evidence safely",
      operating_principles: [], active_objective_ids: [], last_reviewed_at: null }, objectives: [], project_objectives: {} };
    const issue = syntheticIssue(), lineage: IssueLineage = { issue, tasks: [], sessions: [], candidates: [], evidence: [], evidence_gaps: [] };
    const budgetService = createBudgetService(root, { clock: () => new Date(at), readBudgetPolicy: () => readBudgetPolicy(root),
      readBudgetLedger: () => unknownLedger(fingerprint) });
    const roleBudget = (role: string) => budgetService.preview({ attribution: { company_id: "surtec", objective_ids: [], project_ids: ["alpha"],
      issue_id: issue.id, role_id: role, execution_id: "synthetic-preview" }, base_caps: caps });
    const roles = ["portfolio-analyst", "planner", "software-engineer", "reviewer", "qa-evaluator", "operations-observer"] as WorkflowRoleId[];
    const previews = vi.fn((request: api.ContextPreviewRequest): api.ContextPreview => ({ schema_version: 1, fingerprint: hash, allowed: false,
      blocked_reasons: ["Budget accounting requires current evidence"], runtime_read_limitation: "Runtime reads are not guaranteed project-only.",
      manifest: syntheticManifest(request.role_id as WorkflowRoleId, request.agent), budget_preview: roleBudget(request.role_id) }));
    const workflowPreview = vi.fn((request: api.WorkflowPreviewRequest): api.WorkflowPreview => {
      const selected = Object.entries(request.selected_agents).map(([role, agent]) => ({ role_id: role as WorkflowRoleId, agent_id: agent!,
        sandbox: "read-only" as const, client_context_categories: (request.client_context_categories[role as WorkflowRoleId] ?? []) as ClientContextCategory[] }));
      return { schema_version: 1, request, fingerprint: hash, issue_revision: request.expected_revision, issue_status: "authorized", scope_revision: 1,
        scope_fingerprint: hash, plan: { template_id: request.template_id, template_version: 1, root_human_gate: "workflow-approval",
          stages: [{ kind: "analysis", role_id: selected[0]!.role_id, sandbox: "read-only", before_human_gates: [], requires_candidate: false,
            requires_passed_verification: false, captures_verification: false }], correction_stages: [], final_human_gate: "proposal-acknowledgement", max_model_tasks: 1 },
        role_assignments: selected, review_policy: { intrinsic_depth: "passive", minimum_depth: "focused", effective_depth: "focused", qa_required: false,
          reasons: [], fingerprint: hash }, budget: request.budget!, correction: { enabled: false, max_corrections: 0, budget: null }, candidate: null,
        source_fingerprints: [], policy_fingerprint: hash, testing_policy_fingerprint: hash, minimum_review_depth: "focused", testing_mode: "functional",
        roles: selected.map((entry) => ({ role_id: entry.role_id, manifest: syntheticManifest(entry.role_id, entry.agent_id) })),
        budget_previews: selected.map((entry) => ({ role_id: entry.role_id, preview: roleBudget(entry.role_id), workflow_preview: roleBudget(entry.role_id) })),
        allowed: false, blocked_reasons: ["Budget accounting requires current evidence"], runtime_read_limitation: "Runtime reads are not guaranteed project-only.",
        candidate_reference_limitation: "Live tree inspection is separate." };
    });
    const signalFeed = { schema_version: 1 as const, observed_at: at, pinned_signal_ids: [], warnings: [], signals: [] };
    const dependencies: AppDependencies = {
      routines: createRoutineService(root, { stateRoot: state, clock: () => new Date(at), readOrganization: () => organization, listProjects: () => [{ id: "alpha" }] }),
      signals: { read: async () => signalFeed, decide: execute } as unknown as AppDependencies["signals"],
      inbox: async () => ({ items: [], repos: [] }),
      organization: { read: () => organization } as unknown as AppDependencies["organization"],
      issues: { list: () => [issue], get: () => lineage, dispatch: execute } as unknown as AppDependencies["issues"],
      context: { roles: () => roles.map((id) => ({ id, display_name: id, responsibility: "Synthetic role", sandbox_ceiling: id === "software-engineer" ? "workspace-write" : "read-only",
        agents: ["tech-lead", "backend-engineer"] })), preview: previews } as unknown as AppDependencies["context"],
      workflows: { list: () => [], preview: workflowPreview, start: execute } as unknown as AppDependencies["workflows"],
      integrations: { read: async () => ({ schema_version: 2, project_id: "alpha", observed_at: at, trace_id: null,
        source_control: { provider: "git", configured: true, health: "ok", branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0,
          remote: { provider: "github", configured: false, health: "unconfigured", pull_requests: null, issues: null } },
        ci: { provider: "github-actions", configured: false, health: "unconfigured", status: null, branch: null, run_id: null },
        dependencies: { provider: "npm", configured: false, health: "unconfigured", outdated: null, observed_at: at }, deployments: [] }),
        invalidate: vi.fn() } as unknown as AppDependencies["integrations"],
    };
    const app = () => createApp(root, dispatch, processes as unknown as ProcessManager, createHttpSecurity(), dependencies);
    server = serve({ fetch: app().fetch, hostname: "127.0.0.1", port: 0 });
    if (!server.listening) await once(server, "listening");
    const apiPort = (server.address() as AddressInfo).port, apiUrl = `http://127.0.0.1:${apiPort}`;
    vite = await createViteServer({ configFile: false, root: resolve("dashboard"), plugins: [react()], cacheDir: join(root, "vite-cache"),
      server: { host: "127.0.0.1", port: 0, strictPort: true, proxy: { "/api": { target: apiUrl } } } });
    await vite.listen(); const dashboardUrl = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
    try { browser = await chromium.launch({ headless: true }); }
    catch (error) { if (process.platform !== "win32" || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error;
      browser = await chromium.launch({ headless: true, channel: "msedge" }); }
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), pageErrors: string[] = [], consoleErrors: string[] = [],
      httpErrors: number[] = [], externalRequests: string[] = [], budgetQueries: string[] = [], mutationPaths: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message)); page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("response", (response) => { if (response.status() >= 400) httpErrors.push(response.status()); });
    page.on("request", (request) => { const url = new URL(request.url()); if (url.pathname === "/api/budgets") budgetQueries.push(url.search);
      if (request.method() !== "GET" && url.pathname.startsWith("/api/")) mutationPaths.push(url.pathname); });
    await page.route("**/*", async (route) => { const url = new URL(route.request().url());
      if (["127.0.0.1", "localhost"].includes(url.hostname)) await route.continue();
      else if (url.hostname === "fonts.googleapis.com" && url.pathname === "/css2" && route.request().resourceType() === "stylesheet")
        await route.fulfill({ status: 200, contentType: "text/css", body: "" });
      else { externalRequests.push(url.hostname); await route.abort(); } });
    await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" }); await page.getByText("Cockpit diario", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "Detalle operativo de alpha", exact: true }).click();
    const projectBudget = page.getByRole("region", { name: "Presupuesto del proyecto", exact: true });
    try { await projectBudget.getByText("Disponibilidad informativa: no disponible.", { exact: true }).waitFor(); }
    catch (error) { console.log("BUDGET_SUMMARY_BROWSER_OBSERVATION", JSON.stringify({ project_summary: await projectBudget.textContent(), http_statuses: httpErrors })); throw error; }
    await projectBudget.getByText(/Fuentes y consumo/).click();
    await projectBudget.getByText("policy:company-rule · company: surtec", { exact: true }).click();
    await projectBudget.getByText(/consumido desconocido · probado 20 · reservado 50 · restante desconocido/).waitFor();
    expect(await projectBudget.textContent()).toContain("probado 20"); expect(await projectBudget.textContent()).toContain("reservado 50");
    expect(await projectBudget.textContent()).toContain("restante desconocido"); expect(await projectBudget.textContent()).toContain(fingerprint);
    await projectBudget.getByRole("button", { name: "Actualizar presupuesto" }).click();
    await projectBudget.getByText("Disponibilidad informativa: no disponible.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Issues", exact: true }).click();
    const issueCard = page.locator("#work-issue-synthetic-budget-issue"); await issueCard.getByRole("button", { name: "Ver linaje y evidencia" }).click();
    await issueCard.getByRole("region", { name: "Presupuesto del proyecto", exact: true }).getByText("Disponibilidad informativa: no disponible.", { exact: true }).waitFor();
    await issueCard.getByRole("button", { name: "Previsualizar contexto del issue" }).click();
    const context = issueCard.getByRole("region", { name: "Preview de contexto", exact: true });
    const contextBudget = context.getByRole("region", { name: "Presupuesto informativo del contexto", exact: true });
    await contextBudget.getByText("Disponibilidad informativa: no disponible.", { exact: true }).waitFor();
    expect(await contextBudget.textContent()).toContain("budget-accounting-unavailable");
    expect(await contextBudget.textContent()).toContain("límite 100"); expect(await contextBudget.textContent()).toContain("probado 20");
    expect(await context.textContent()).toContain("Budget accounting requires current evidence");
    await issueCard.getByRole("button", { name: "Ver workflow", exact: true }).click();
    await issueCard.getByRole("button", { name: "Previsualizar workflow", exact: true }).click();
    const workflow = issueCard.getByRole("region", { name: "Preview de workflow", exact: true });
    const workflowBudget = workflow.getByRole("region", { name: /Presupuesto/ });
    await workflowBudget.waitFor(); expect(await workflowBudget.textContent()).toContain("budget-accounting-unavailable");
    await workflowBudget.getByText(/Fuentes y consumo/).click();
    await workflowBudget.getByText("policy:company-rule · company: surtec", { exact: true }).click();
    await workflowBudget.getByText(/consumido desconocido · probado 20 · reservado 50 · restante desconocido/).waitFor();
    expect(await issueCard.getByRole("button", { name: "Iniciar workflow aprobado" }).isDisabled()).toBe(true);
    expect(await issueCard.getByRole("button", { name: /Despachar|Crear tarea/i }).isDisabled()).toBe(true);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const layout = await workflow.evaluate((node) => { const box = node.getBoundingClientRect(); return { width: box.width,
        ownScroll: node.scrollWidth, client: node.clientWidth, textVisible: getComputedStyle(node).visibility !== "hidden" && getComputedStyle(node).display !== "none" }; });
      expect(layout.width).toBeGreaterThan(100); expect(layout.textVisible).toBe(true); expect(layout.ownScroll).toBeLessThanOrEqual(layout.client + 2);
      const refreshControl = await issueCard.getByRole("button", { name: "Actualizar presupuesto", exact: true }).evaluate((node) => {
        const box = node.getBoundingClientRect(), style = getComputedStyle(node); return { width: box.width,
          fontSize: Number.parseFloat(style.fontSize), foreground: style.color, background: style.backgroundColor };
      });
      expect(refreshControl.width).toBeGreaterThan(100); expect(refreshControl.width).toBeLessThan(280);
      expect(refreshControl.fontSize).toBeGreaterThanOrEqual(10); expect(refreshControl.foreground).not.toBe(refreshControl.background);
    }
    expect(previews).toHaveBeenCalledOnce(); expect(workflowPreview).toHaveBeenCalledOnce();
    const previousSession = await page.evaluate(async () => (await (await fetch("/api/session", { cache: "no-store" })).json()).token as string);
    await new Promise<void>((done, reject) => server!.close((error) => error ? reject(error) : done())); apiClosed = !server.listening;
    server = serve({ fetch: app().fetch, hostname: "127.0.0.1", port: apiPort }); if (!server.listening) await once(server, "listening"); apiClosed = false;
    expect(await page.evaluate(async (previous) => (await (await fetch("/api/session", { cache: "no-store" })).json()).token !== previous, previousSession)).toBe(true);
    await page.reload(); await page.getByText("Cockpit diario", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Issues", exact: true }).click(); await page.locator("#work-issue-synthetic-budget-issue").getByRole("button", { name: "Ver linaje y evidencia" }).click();
    await page.getByRole("region", { name: "Presupuesto del proyecto", exact: true }).getByText("Disponibilidad informativa: no disponible.", { exact: true }).waitFor();
    expect(budgetQueries.length).toBeGreaterThanOrEqual(4); expect(budgetQueries.every((query) => query === "?project_id=alpha")).toBe(true);
    expect(mutationPaths).toEqual(["/api/context/preview", "/api/workflows/preview"]);
    expect(readFileSync(ledgerPath)).toEqual(before.bytes); expect(lstatSync(ledgerPath).mtimeMs).toBe(before.modified);
    expect(existsSync(join(state, "tasks"))).toBe(false); expect(existsSync(join(state, "routines"))).toBe(false);
    expect(dispatch).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(pageErrors).toEqual([]); expect(consoleErrors).toEqual([]); expect(httpErrors).toEqual([]); expect(externalRequests).toEqual([]);
  } finally {
    try { if (browser) await browser.close(); browserClosed = !browser?.isConnected(); }
    finally { try { if (vite) await vite.close(); viteClosed = !vite?.httpServer?.listening; }
      finally { if (server?.listening) await new Promise<void>((done, reject) => server!.close((error) => error ? reject(error) : done())); apiClosed = !server?.listening;
        if (browserClosed && viteClosed && apiClosed) { expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
          expect(basename(root).startsWith("surtec-budget-summary-browser-")).toBe(true); expect(lstatSync(root).isSymbolicLink()).toBe(false);
          rmSync(root, { recursive: true, force: true }); }
        const result = { fixture_id: basename(root), browser_closed: browserClosed, vite_closed: viteClosed, api_stopped: apiClosed,
          workspace_removed: !existsSync(root), failures: [] as string[] };
        console.log("BUDGET_SUMMARY_BROWSER_CLEANUP", JSON.stringify(result));
        expect(result).toMatchObject({ browser_closed: true, vite_closed: true, api_stopped: true, workspace_removed: true });
      }
    }
  }
}, 90000);
