// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TaskDetailModel } from "../../../../lib/state/types";
import { TaskDetailView } from "./TaskDetailView";

const detail: TaskDetailModel = {
  task: {
    envelope: {
      id: "T-1", source: "dashboard", project: "alpha", task_type: "implementation", agent: "engineer",
      title: "Ship evidence", instructions: "Do it", repo_path: "/repo", branch: "agent/T-1", sandbox: "workspace-write",
      expected_outputs: [], requires_human_approval: true, metadata: {},
    },
    lifecycle: "finished", outcome: "completed", created_at: "2026-09-21T10:00:00Z", started_at: "2026-09-21T10:00:00Z",
    updated_at: "2026-09-21T10:00:05Z", finished_at: "2026-09-21T10:00:05Z", logs_path: null,
    result: {
      task_id: "T-1", agent: "engineer", status: "completed", summary: "Evidence shipped", files_changed: ["src/x.ts"],
      commands_run: ["npm test"], tests_run: ["unit"], risks: [], blockers: [], next_steps: ["Review"], artifacts: [], logs_path: "",
      verification: { status: "passed", checks: [{ command: "npm test", ok: true, output_tail: "12 passed" }] },
    },
  },
  events: [], duration_ms: 5_000,
  execution: { mode: "workspace-write-verify", thread_id: "thread-1", turn_id: "turn-1", trace_id: null, span_id: null, branch: "agent/T-1", worktree_path: "/wt", committed: true, diffstat: "1 file changed" },
  diff: { status: "available", path: "reports/T-1.diff", content: "+evidence", truncated: false },
  policy_decisions: [], approvals: [], usage: [], retries: [], review_history: [], cleanup: { status: "retained", at: null },
};

function admittedDetail(): TaskDetailModel {
  const record = structuredClone(detail);
  record.task.envelope.context_admission = { schema_version: 2, kind: "workflow-stage", workflow_id: "W-1", stage_id: "S-1", stage_generation: 1, stage_kind: "implementation", task_id: "T-1", template_id: "trivial-change", template_version: 1, grant_id: "G-1", authority_revision: 1, role_id: "software-engineer", issue_id: "I-1", issue_revision: 3, scope_revision: 1, scope_fingerprint: "b".repeat(64), approved_plan: null, predecessor_stage_id: "S-plan", handoff_id: "H-1", candidate: null, manifest_fingerprint: "a".repeat(64), instructions_length: 5, instructions_hash: "a".repeat(64) };
  record.task.envelope.context_manifest = {
    schema_version: 1, fingerprint: "a".repeat(64), project_id: "alpha", role_id: "software-engineer", agent_id: "engineer", task_kind: "implementation", sandbox: "workspace-write", tools: ["inspect", "edit-authorized-scope"], approval_rules: ["publication"],
    budget: { max_attempts: 1, max_runtime_ms: 60000, max_total_tokens: 10000 }, limits: { max_lines: 500, max_bytes: 60000, max_sources: 64 }, sources: [], selected_categories: [], excluded_categories: ["confidential-notes"], omitted_sources: [], total_bytes: 0, total_lines: 0,
    routing: { action: "direct", work_scale: "trivial", review_depth: "full", qa_required: true, reasons: [], delegation: { admitted: false, executable: false, reasons: [] } },
    testing: { mode: "functional", minimum_review_depth: "full", runner_ids: [], commands: ["npm test"], reasons: [], requires_red_evidence: false },
  };
  record.task.testing_evidence = {
    schema_version: 1, fingerprint: "c".repeat(64), task_id: "T-1", execution_id: "run-1", project_id: "alpha", issue_id: "I-1", issue_revision: 3, scope_revision: 1, scope_fingerprint: "b".repeat(64), context_fingerprint: "a".repeat(64), mode: "functional", requirements: [{ stage: "functional", command_fingerprint: "d".repeat(64), probe_fingerprint: null, assertion_ids: [] }], no_refactor_fingerprint: null, policy_fingerprint: "e".repeat(64), implementation: { started_at: "2026-09-21T10:00:00Z", finished_at: "2026-09-21T10:00:01Z", thread_id: "thread-1", turn_id: "turn-1" },
    candidate: { id: "C-1", base_revision: "base-sha", candidate_revision: "candidate-sha", diff_fingerprint: "f".repeat(64) },
    observations: [{ stage: "functional", command_fingerprint: "d".repeat(64), probe_fingerprint: null, assertions: [], outcome: "passed", exit_code: 0, started_at: "2026-09-21T10:00:02Z", finished_at: "2026-09-21T10:00:03Z", revision: "candidate-sha", before_fingerprint: "f".repeat(64), after_fingerprint: "f".repeat(64) }],
  };
  return record;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("TaskDetailView", () => {
  it.each([
    [3, [], "No hay eventos registrados disponibles", "r3 / No disponible"],
    [3, [1], "Hay revisiones del snapshot sin un evento observado", "r3 / r1"],
    [3, [1, 3], "Las revisiones observadas coinciden", "r3 / r3"],
    [3, [3, 3], "Las revisiones observadas coinciden", "r3 / r3"],
    [3, [4], "Hay eventos posteriores al snapshot leído", "r3 / r4"],
    [undefined, [1], "La revisión del snapshot no está registrada", "Desconocida / r1"],
  ] as const)("exposes history uncertainty for snapshot %s and event revisions %j without claiming completeness", async (revision, revisions, observation, comparison) => {
    const record = structuredClone(detail); record.task.revision = revision;
    record.events = revisions.map((value, index) => ({ event_id: `E-${index}`, task_id: "T-1", type: "warning", at: "2026-09-21T10:00:00Z", revision: value, run_id: null, attempt: null, payload: {} }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => record })) as unknown as typeof fetch);
    render(<TaskDetailView taskId="T-1" onBack={() => {}} />);
    const history = within(await screen.findByRole("region", { name: "Historial registrado" }));
    expect(history.getByRole("status")).toHaveTextContent(observation);
    expect(history.getByText(comparison)).toBeInTheDocument();
    expect(history.getByText(/la integridad histórica no está confirmada/)).toBeInTheDocument();
    expect(history.getByText(/reiniciar no recupera eventos ausentes ni habilita reintentos/)).toBeInTheDocument();
    expect(screen.queryByText("Lifecycle completo")).toBeNull();
    expect(history.queryByRole("button")).toBeNull();
  });

  it("does not compare another task's event revision as current history", async () => {
    const record = structuredClone(detail); record.task.revision = 3;
    record.events = [{ event_id: "E-other", task_id: "T-other", type: "warning", at: "2026-09-21T10:00:00Z", revision: 3, run_id: null, attempt: null, payload: {} }];
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => record })) as unknown as typeof fetch);
    render(<TaskDetailView taskId="T-1" onBack={() => {}} />);
    const history = within(await screen.findByRole("region", { name: "Historial registrado" }));
    expect(history.getByRole("status")).toHaveTextContent("No se confirma la correspondencia del historial con esta tarea.");
    expect(history.getByText("r3 / No disponible")).toBeInTheDocument();
  });

  it("opens the exact owning issue/workflow through its scoped callback, not a URL or publication action", async () => {
    const owned = structuredClone(detail);
    owned.task.envelope.context_admission = { schema_version: 2, kind: "workflow-stage", workflow_id: "W-1", stage_id: "S-1", stage_generation: 1, stage_kind: "implementation", task_id: "T-1", template_id: "trivial-change", template_version: 1, grant_id: "G-1", authority_revision: 1, role_id: "software-engineer", issue_id: "I-1", issue_revision: 3, scope_revision: 1, scope_fingerprint: "a".repeat(64), approved_plan: null, predecessor_stage_id: null, handoff_id: null, candidate: null, manifest_fingerprint: "a".repeat(64), instructions_length: 5, instructions_hash: "a".repeat(64) };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => owned })) as unknown as typeof fetch);
    const open = vi.fn(); render(<TaskDetailView taskId="T-1" onBack={() => {}} onOpenWorkflow={open} />);
    const button = await screen.findByRole("button", { name: "Abrir workflow del issue" }); expect(open).not.toHaveBeenCalled(); fireEvent.click(button);
    expect(open).toHaveBeenCalledWith({ issueId: "I-1", workflowId: "W-1", projectId: "alpha" });
    expect(screen.getByRole("region", { name: "Workflow propietario" }).querySelector("a")).toBeNull();
  });

  it("does not infer workflow ownership from historical metadata", async () => {
    const old = structuredClone(detail); old.task.envelope.metadata.workflow_id = "W-unproven";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => old })) as unknown as typeof fetch);
    render(<TaskDetailView taskId="T-1" onBack={() => {}} onOpenWorkflow={vi.fn()} />); await screen.findByText("Evidence shipped");
    expect(screen.queryByRole("region", { name: "Workflow propietario" })).toBeNull();
  });
  it("renders result, diff, commands, verification, budgets, and cleanup", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => detail })) as unknown as typeof fetch);
    render(<TaskDetailView taskId="T-1" onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText("Evidence shipped")).toBeInTheDocument());
    expect(screen.getByText("+evidence")).toBeInTheDocument();
    expect(screen.getAllByText("npm test").length).toBeGreaterThan(0);
    expect(screen.getAllByText("retained").length).toBeGreaterThan(0);
    expect(screen.getByText("passed")).toBeInTheDocument();
    expect(screen.getByText(/Tarea histórica sin manifiesto registrado/)).toBeInTheDocument();
  });

  it("renders the recorded manifest as requirements, without private source bodies or invented verification", async () => {
    const admitted = structuredClone(detail);
    admitted.task.envelope.context_manifest = {
      schema_version: 1, fingerprint: "a".repeat(64), project_id: "alpha", role_id: "software-engineer", agent_id: "engineer", task_kind: "implementation", sandbox: "workspace-write", tools: ["inspect", "edit-authorized-scope"], approval_rules: ["publication"],
      budget: { max_attempts: 1, max_runtime_ms: 60000, max_total_tokens: 10000 }, limits: { max_lines: 500, max_bytes: 60000, max_sources: 64 }, sources: [], selected_categories: [], excluded_categories: ["confidential-notes"], omitted_sources: [], total_bytes: 0, total_lines: 0,
      routing: { action: "direct", work_scale: "trivial", review_depth: "full", qa_required: false, reasons: [], delegation: { admitted: false, executable: false, reasons: [] } },
      testing: { mode: "strict-tdd", minimum_review_depth: "full", runner_ids: [], commands: [], reasons: [], requires_red_evidence: true },
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => admitted })) as unknown as typeof fetch);
    render(<TaskDetailView taskId="T-1" onBack={() => {}} />);
    const evidence = within(await screen.findByRole("region", { name: "Manifiesto de contexto" }));
    expect(evidence.getByText("software-engineer")).toBeInTheDocument();
    expect(evidence.getByText("a".repeat(64))).toBeInTheDocument();
    expect(evidence.getByText(/strict-tdd · RED requerido/)).toBeInTheDocument();
    expect(evidence.getByText(/no demuestra que los checks/)).toBeInTheDocument();
    expect(evidence.queryByText("passed")).toBeNull();
    expect(evidence.queryByText("Do it")).toBeNull();
    expect(evidence.queryByText(/Tarea histórica/)).toBeNull();
  });

  it("clears evidence when navigating tasks and ignores the former task's late response", async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("T-1")
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : Promise.resolve({ ok: true, json: async () => ({ ...detail, task: { ...detail.task, envelope: { ...detail.task.envelope, id: "T-2", title: "Second task" } } }) } as Response)));
    const view = render(<TaskDetailView taskId="T-1" onBack={() => {}} />);
    view.rerender(<TaskDetailView taskId="T-2" onBack={() => {}} />);
    await screen.findByText("Second task");
    finish({ ok: true, json: async () => detail } as Response);
    await waitFor(() => expect(screen.queryByText("Ship evidence")).toBeNull());
    expect(screen.getByText("Second task")).toBeInTheDocument();
  });

  it.each([
    ["running", null, "Trabajando"],
    ["finished", "blocked", "Bloqueado"],
    ["finished", "needs-review", "Necesita decisión"],
    ["finished", "failed", "Necesita decisión"],
    ["finished", "partial", "Necesita decisión"],
    ["finished", "completed", "Sin etiqueta operativa primaria"],
    ["finished", "cancelled", "Sin etiqueta operativa primaria"],
    ["queued", null, "Sin etiqueta operativa primaria"],
  ] as const)("keeps %s/%s as task evidence, not issue acceptance", async (lifecycle, outcome, expected) => {
    const record = structuredClone(detail); record.task.lifecycle = lifecycle; record.task.outcome = outcome;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => record })) as unknown as typeof fetch);
    render(<TaskDetailView taskId="T-1" onBack={() => {}} />);
    const region = within(await screen.findByRole("region", { name: "Estado operativo de la tarea" }));
    expect(region.getByText(`${expected} · lifecycle ${lifecycle} · resultado ${outcome ?? "sin resultado"}`)).toBeInTheDocument();
    expect(region.getByText(/Esta tarea no acredita Hecho ni aceptación del issue/)).toBeInTheDocument();
    if (["blocked", "needs-review", "failed", "partial"].includes(outcome ?? "")) expect(region.getByText(/Motivo exacto no clasificado/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ejecutar|Reintentar|Aceptar|Publicar/ })).toBeNull();
  });

  it("keeps recorded source time and unknown historical consumption separate from polling", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => detail })) as unknown as typeof fetch);
    render(<TaskDetailView taskId="T-1" onBack={() => {}} />);
    const region = within(await screen.findByRole("region", { name: "Estado operativo de la tarea" }));
    expect(region.getByText("2026-09-21T10:00:05Z").getAttribute("datetime")).toBe(detail.task.updated_at);
    expect(screen.getAllByText("Desconocidos/—")).toHaveLength(2);
    expect(screen.queryByText("0/—")).toBeNull();
    expect(region.getByText(/no al momento del polling/)).toBeInTheDocument();
  });

  it("renders admitted scope/role/stage/handoff and captured infrastructure evidence independently from model claims", async () => {
    const record = admittedDetail(); record.task.envelope.instructions = "DO-NOT-EXPORT-INSTRUCTIONS";
    record.task.envelope.metadata.confidential_notes = "DO-NOT-EXPORT-NOTES";
    const fetch = vi.fn(async () => ({ ok: true, json: async () => record })); vi.stubGlobal("fetch", fetch);
    const open = vi.fn(); render(<TaskDetailView taskId="T-1" onBack={() => {}} onOpenWorkflow={open} />);
    const scope = within(await screen.findByRole("region", { name: "Scope y requisitos registrados" }));
    expect(scope.getByText("I-1 · scope r1")).toBeInTheDocument();
    expect(scope.getByText("software-engineer · trivial")).toBeInTheDocument();
    expect(scope.getByText("full · mínimo full · QA requerido")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Workflow propietario" })).getByText("S-plan · H-1")).toBeInTheDocument();
    const testing = within(screen.getByRole("region", { name: "Testing capturado por infraestructura" }));
    expect(testing.getByText("Referencias registradas de tarea, contexto y scope coincidentes.")).toBeInTheDocument();
    expect(testing.getByText("T-1 · run-1")).toBeInTheDocument();
    expect(testing.getByText("base-sha · candidate-sha")).toBeInTheDocument();
    expect(testing.getByText(/Vigencia actual del candidato: desconocida/)).toBeInTheDocument();
    expect(testing.getByText(/no comprueban el sello/)).toBeInTheDocument();
    expect(screen.queryByText("DO-NOT-EXPORT-INSTRUCTIONS")).toBeNull(); expect(screen.queryByText("DO-NOT-EXPORT-NOTES")).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(fetch.mock.calls).toEqual([["/api/tasks/T-1/detail"]]);
  });

  it.each(["task_id", "project_id", "context_fingerprint", "issue_id", "scope_fingerprint"] as const)("does not confirm a receipt with mismatched %s", async (field) => {
    const record = admittedDetail(); record.task.testing_evidence![field] = "different";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => record })) as unknown as typeof fetch);
    render(<TaskDetailView taskId="T-1" onBack={() => {}} />);
    const region = within(await screen.findByRole("region", { name: "Testing capturado por infraestructura" }));
    expect(region.getByText("Referencias del receipt no confirmadas para esta tarea/contexto/scope.")).toBeInTheDocument();
    expect(region.queryByText("Referencias registradas de tarea, contexto y scope coincidentes.")).toBeNull();
  });

  it("refuses workflow navigation and scope claims from another task's v2 admission", async () => {
    const record = admittedDetail(); if (record.task.envelope.context_admission?.schema_version === 2) record.task.envelope.context_admission.task_id = "T-other";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => record })) as unknown as typeof fetch);
    render(<TaskDetailView taskId="T-1" onBack={() => {}} onOpenWorkflow={vi.fn()} />);
    await screen.findByText(/La admisión v2 no corresponde a esta tarea/);
    expect(screen.queryByRole("region", { name: "Workflow propietario" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Abrir workflow del issue" })).toBeNull();
    expect(screen.getByText("Sin binding de issue confirmado")).toBeInTheDocument();
    expect(screen.getByText("Referencias del receipt no confirmadas para esta tarea/contexto/scope.")).toBeInTheDocument();
  });

  it.each(["issue_revision", "scope_revision"] as const)("does not confirm a receipt with a different %s", async (field) => {
    const record = admittedDetail(); record.task.testing_evidence![field] = 99;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => record })) as unknown as typeof fetch);
    render(<TaskDetailView taskId="T-1" onBack={() => {}} />);
    expect(await screen.findByText("Referencias del receipt no confirmadas para esta tarea/contexto/scope.")).toBeInTheDocument();
  });

  it("does not confirm a captured candidate that differs from the exact admission candidate", async () => {
    const record = admittedDetail(), admission = record.task.envelope.context_admission;
    if (admission?.schema_version !== 2) throw new Error("Expected v2 fixture");
    admission.candidate = { candidate_id: "C-other", issue_id: "I-1", repository_id: "alpha", task_id: "T-1", execution_id: "run-1", scope_revision: 1, base_revision: "base-sha", candidate_revision: "candidate-sha", changed_paths: ["src/x.ts"], diff_fingerprint: "f".repeat(64), content_fingerprint: "a".repeat(64), testing_evidence_fingerprint: "c".repeat(64) };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => record })) as unknown as typeof fetch);
    render(<TaskDetailView taskId="T-1" onBack={() => {}} />);
    expect(await screen.findByText("Referencias del receipt no confirmadas para esta tarea/contexto/scope.")).toBeInTheDocument();
    expect(screen.getByText(/Candidato admitido C-other/)).toBeInTheDocument();
  });

  it("records a known failure kind without guessing the exhausted limit or exposing private error text", async () => {
    const record = structuredClone(detail); record.task.outcome = "needs-review";
    record.task.orchestration = { attempts: 1, max_attempts: 2, max_runtime_ms: 60000, max_total_tokens: 10000, cumulative_tokens: 4, retry_at: null, cancel_requested_at: null, lease: null, last_failure: { kind: "budget", message: "PRIVATE ERROR D:/private/token.txt", at: "2026-09-21T10:00:04Z", run_id: "run-budget" } };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => record })) as unknown as typeof fetch);
    render(<TaskDetailView taskId="T-1" onBack={() => {}} />);
    const region = within(await screen.findByRole("region", { name: "Estado operativo de la tarea" }));
    expect(region.getByText(/Último fallo registrado: budget; ejecución run-budget/)).toBeInTheDocument();
    expect(region.getByText(/La causa concreta de la decisión del issue o el límite aplicable no están confirmados/)).toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE ERROR/)).toBeNull();
    expect(region.queryByText(/tokens agotados|intentos agotados/)).toBeNull();
    expect(screen.getByText("4/10000")).toBeInTheDocument();
  });

  it("rejects a mismatched detail response and keeps transport errors private", async () => {
    const record = structuredClone(detail); record.task.envelope.id = "T-other";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => record })) as unknown as typeof fetch);
    const view = render(<TaskDetailView taskId="T-1" onBack={() => {}} />);
    await screen.findByText(/Lectura no confirmada/);
    expect(screen.queryByText("Evidence shipped")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("PRIVATE TRANSPORT /private/auth.json"); }));
    view.rerender(<TaskDetailView taskId="T-2" onBack={() => {}} />);
    await screen.findByText(/Lectura no confirmada/);
    expect(screen.queryByText(/PRIVATE TRANSPORT|auth.json/)).toBeNull();
  });

  it("discards an older overlapping poll and retains same-task evidence on a private refresh failure", async () => {
    let tick!: () => void;
    const originalInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, delay: number) => {
      if (delay === 3000) tick = callback;
      return originalInterval(callback, delay);
    }) as typeof setInterval);
    let resolveOlder!: (response: Response) => void;
    const updated = structuredClone(detail); updated.task.envelope.title = "Newest evidence";
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => detail })
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOlder = resolve; }))
      .mockResolvedValueOnce({ ok: true, json: async () => updated })
      .mockRejectedValueOnce(new Error("PRIVATE REFRESH C:/private/auth.json"));
    vi.stubGlobal("fetch", fetch); render(<TaskDetailView taskId="T-1" onBack={() => {}} />);
    await screen.findByText("Ship evidence");
    act(() => { tick(); }); act(() => { tick(); });
    await screen.findByText("Newest evidence");
    await act(async () => { resolveOlder({ ok: true, json: async () => detail } as Response); });
    expect(screen.queryByText("Ship evidence")).toBeNull();
    await act(async () => { tick(); });
    await screen.findByText(/mostrando la última evidencia/);
    expect(screen.getByText("Newest evidence")).toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE REFRESH|auth.json/)).toBeNull();
  });
});
