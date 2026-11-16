// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ClientCommitment, ClientRecord, ClientSummary } from "../../../../lib/client-portfolio";
import type { IssueLineage, WorkIssue } from "../../../../lib/issues/types";
import type { ProjectView } from "../../../../lib/state/types";
import * as api from "../api";
import { ClientCommitmentsView } from "./ClientCommitmentsView";

const observedAt = "2026-10-16T12:00:00.000Z";
const privateFeedback = "SYNTHETIC_PRIVATE_DELIVERY_RESPONSE";
const client: ClientRecord = {
  id: "client-fictional", display_name: "Fictional private client", status: "active", criticality: "medium",
  sla_note: "Fictional SLA", next_review_date: null, confidential_notes: "SYNTHETIC_PRIVATE_CLIENT_NOTES",
  created_at: observedAt, updated_at: observedAt,
};
const summary: ClientSummary = {
  id: client.id, display_name: client.display_name, status: client.status, criticality: client.criticality,
  project_ids: ["alpha"], next_review_date: null, active_commitment_count: 0,
};
const projects: ProjectView[] = ["alpha", "beta"].map(id => ({
  id, status: "active", health: null, note: null, repo: null, path: null, configured: false,
  git: null, last_activity: null, task_counts: { inProgress: 0, finished: 0 },
}));
const completed: ClientCommitment = {
  id: "commitment-alpha", project_id: "alpha", client_id: client.id, title: "Fictional saved milestone",
  expected_outcome: "A separate local outcome", due_date: null, priority: 3, criticality: "medium", state: "completed",
  issue_numbers: [], pull_request_numbers: [], task_ids: [], session_ids: [], next_action: "Inspect separate facts",
  created_at: observedAt, updated_at: observedAt,
};
const personal: ClientCommitment = { ...completed, id: "commitment-beta", project_id: "beta", client_id: null, title: "Personal saved experiment", state: "planned" };

function issueFor(projectId: string, commitmentId: string, sequence: number): WorkIssue {
  const scope = { expected_outcome: "Inspect a local observation", acceptance_criteria: ["Preserve the separate facts"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["ui"], explicit_exclusions: [] };
  return {
    schema_version: 1, id: `I-00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`, project_id: projectId,
    objective_id: null, parent_issue_id: null, title: `Delivery issue ${sequence}`, expected_outcome: scope.expected_outcome,
    acceptance_criteria: scope.acceptance_criteria, status: "proposed", work_scale: "trivial",
    classification_inputs: { affected_domains: ["ui"], requires_migration: false, security_impact: false },
    classification_rationale: ["Narrow local work"], plan: [], authorized_scope: scope,
    scope_revision: 1, scope_changed_at: null, scope_change_approval_id: null, scope_change_proposal: null,
    priority: 3, criticality: "low", blocked_by_issue_ids: [], assigned_role_id: null,
    related_commitment_ids: [commitmentId], external_references: [], next_action: null,
    task_ids: [], evidence_ids: [], candidate_ids: [], created_at: observedAt, updated_at: observedAt, revision: 1,
  };
}
const alphaIssue = issueFor("alpha", completed.id, 1);
const betaIssue = issueFor("beta", personal.id, 2);
const unrelated = issueFor("alpha", "another-commitment", 3);

function lineageFor(issue: WorkIssue, withFeedback = false): IssueLineage {
  const evidenceId = "E-00000000-0000-4000-8000-000000000001";
  return {
    issue: { ...issue, evidence_ids: withFeedback ? [evidenceId] : [] }, tasks: [], candidates: [], evidence_gaps: [], sessions: [],
    evidence: withFeedback ? [{
      schema_version: 1, id: evidenceId, issue_id: issue.id, task_id: null, execution_id: null,
      candidate_id: null, candidate_revision: null, diff_fingerprint: null, scope_revision: 1,
      kind: "work-product", label: "Operator-entered delivery observation", reference: `/api/work-issues/${issue.id}`,
      status: "informational", created_at: observedAt,
      delivery_observation: { schema_version: 1, kind: "client-response-recorded", origin: "operator-entered",
        commitment_id: completed.id, occurred_at: observedAt, summary: privateFeedback, source_reference: "response-local",
        next_action: "SYNTHETIC_PRIVATE_FOLLOW_UP" },
    }] : [],
  };
}

beforeEach(() => {
  vi.spyOn(api, "getClients").mockResolvedValue({ clients: [summary] });
  vi.spyOn(api, "getCommitments").mockResolvedValue({ commitments: [completed, personal] });
  vi.spyOn(api, "getClient").mockResolvedValue({ client });
  vi.spyOn(api, "getWorkIssues").mockResolvedValue({ issues: [alphaIssue, betaIssue, unrelated] });
  vi.spyOn(api, "getWorkIssue").mockImplementation(async id => lineageFor(id === betaIssue.id ? betaIssue : alphaIssue));
  vi.spyOn(api, "recordDeliveryObservation");
  vi.spyOn(api, "saveClient").mockResolvedValue({ client });
  vi.spyOn(api, "saveCommitment").mockResolvedValue({ commitment: completed });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function renderDirectory() {
  const result = render(<ClientCommitmentsView projects={projects} />);
  await screen.findByRole("button", { name: /Fictional saved milestone/ });
  return result;
}
function delivery() { return within(screen.getByRole("region", { name: "Entrega y seguimiento" })); }
function editSaved(name = "Fictional saved milestone") { fireEvent.click(screen.getByRole("button", { name: new RegExp(name) })); }

describe("ClientCommitmentsView delivery context", () => {
  it("keeps names masked, starts with no delivery panel and makes no implicit delivery read or write", async () => {
    await renderDirectory();
    expect(screen.getByRole("button", { name: /Cliente 1/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(client.display_name);
    expect(document.body.textContent).not.toContain(client.confidential_notes!);
    expect(screen.queryByRole("region", { name: "Entrega y seguimiento" })).not.toBeInTheDocument();
    expect(api.getClients).toHaveBeenCalledTimes(1);
    expect(api.getCommitments).toHaveBeenCalledTimes(1);
    expect(api.getClient).not.toHaveBeenCalled();
    expect(api.getWorkIssues).not.toHaveBeenCalled();
    expect(api.getWorkIssue).not.toHaveBeenCalled();
    expect(api.recordDeliveryObservation).not.toHaveBeenCalled();
    expect(api.saveClient).not.toHaveBeenCalled();
    expect(api.saveCommitment).not.toHaveBeenCalled();
    expect(screen.getByText(/Compartir notas requiere selección explícita en el formulario de tarea/)).toBeInTheDocument();
  });

  it("looks up only issues linked to the persisted project and commitment, without inferring delivery from completed", async () => {
    await renderDirectory(); editSaved();
    expect(screen.getByRole("heading", { name: "Editar compromiso" })).toBeInTheDocument();
    expect(screen.getByText(/Completado no acredita aceptación técnica, entrega, respuesta ni seguimiento/)).toBeInTheDocument();
    expect(api.getWorkIssues).not.toHaveBeenCalled();
    fireEvent.click(delivery().getByRole("button", { name: "Consultar entrega y seguimiento" }));
    const selection = await delivery().findByRole("combobox", { name: "Issue de entrega" });
    expect(within(selection).getByRole("option", { name: new RegExp(alphaIssue.id) })).toBeInTheDocument();
    expect(within(selection).queryByRole("option", { name: new RegExp(betaIssue.id) })).not.toBeInTheDocument();
    expect(within(selection).queryByRole("option", { name: new RegExp(unrelated.id) })).not.toBeInTheDocument();
    expect(api.getWorkIssue).not.toHaveBeenCalled();
    fireEvent.change(selection, { target: { value: alphaIssue.id } });
    await delivery().findByRole("heading", { name: "Aceptación técnica" });
    expect(api.getWorkIssue).toHaveBeenCalledExactlyOnceWith(alphaIssue.id);
    expect(delivery().queryByText(privateFeedback)).not.toBeInTheDocument();
    expect(api.recordDeliveryObservation).not.toHaveBeenCalled();
    expect(api.saveCommitment).not.toHaveBeenCalled();
  });

  it("does not rebind delivery to an unsaved project draft and resets it when another saved commitment is selected", async () => {
    await renderDirectory(); editSaved();
    fireEvent.change(screen.getByRole("combobox", { name: "Proyecto" }), { target: { value: "beta" } });
    fireEvent.click(delivery().getByRole("button", { name: "Consultar entrega y seguimiento" }));
    let selection = await delivery().findByRole("combobox", { name: "Issue de entrega" });
    expect(within(selection).getByRole("option", { name: new RegExp(alphaIssue.id) })).toBeInTheDocument();
    expect(within(selection).queryByRole("option", { name: new RegExp(betaIssue.id) })).not.toBeInTheDocument();
    fireEvent.change(selection, { target: { value: alphaIssue.id } });
    await delivery().findByRole("heading", { name: "Aceptación técnica" });
    editSaved(personal.title);
    expect(screen.getByRole("combobox", { name: "Cliente (opcional)" })).toHaveValue("");
    expect(delivery().getByRole("button", { name: "Consultar entrega y seguimiento" })).toBeEnabled();
    expect(delivery().queryByRole("heading", { name: "Aceptación técnica" })).not.toBeInTheDocument();
    expect(api.getWorkIssues).toHaveBeenCalledTimes(1);
    fireEvent.click(delivery().getByRole("button", { name: "Consultar entrega y seguimiento" }));
    selection = await delivery().findByRole("combobox", { name: "Issue de entrega" });
    expect(within(selection).getByRole("option", { name: new RegExp(betaIssue.id) })).toBeInTheDocument();
    expect(within(selection).queryByRole("option", { name: new RegExp(alphaIssue.id) })).not.toBeInTheDocument();
    fireEvent.change(selection, { target: { value: betaIssue.id } });
    await waitFor(() => expect(api.getWorkIssue).toHaveBeenLastCalledWith(betaIssue.id));
    expect(api.recordDeliveryObservation).not.toHaveBeenCalled();
    expect(api.saveCommitment).not.toHaveBeenCalled();
  });

  it("fences an old commitment response after selecting personal work and removes the lookup when editing is cancelled", async () => {
    let finishAlpha!: (value: Awaited<ReturnType<typeof api.getWorkIssues>>) => void;
    vi.mocked(api.getWorkIssues).mockImplementationOnce(() => new Promise(resolve => { finishAlpha = resolve; })).mockResolvedValue({ issues: [betaIssue] });
    await renderDirectory(); editSaved();
    fireEvent.click(delivery().getByRole("button", { name: "Consultar entrega y seguimiento" }));
    await waitFor(() => expect(api.getWorkIssues).toHaveBeenCalledTimes(1));
    editSaved(personal.title);
    fireEvent.click(delivery().getByRole("button", { name: "Consultar entrega y seguimiento" }));
    await delivery().findByRole("combobox", { name: "Issue de entrega" });
    await act(async () => finishAlpha({ issues: [alphaIssue] }));
    expect(delivery().queryByRole("option", { name: new RegExp(alphaIssue.id) })).not.toBeInTheDocument();
    expect(delivery().getByRole("option", { name: new RegExp(betaIssue.id) })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar edición" }));
    expect(screen.queryByRole("region", { name: "Entrega y seguimiento" })).not.toBeInTheDocument();
    expect(api.getWorkIssue).not.toHaveBeenCalled();
    expect(api.recordDeliveryObservation).not.toHaveBeenCalled();
    expect(api.saveCommitment).not.toHaveBeenCalled();
  });

  it("keeps recorded response text out of commitment cards and local drafts until an explicit private reveal", async () => {
    vi.mocked(api.getWorkIssue).mockResolvedValue(lineageFor(alphaIssue, true));
    await renderDirectory(); editSaved();
    fireEvent.click(delivery().getByRole("button", { name: "Consultar entrega y seguimiento" }));
    fireEvent.change(await delivery().findByRole("combobox", { name: "Issue de entrega" }), { target: { value: alphaIssue.id } });
    const reveal = await delivery().findByRole("button", { name: "Mostrar detalle privado E-00000000-0000-4000-8000-000000000001" });
    expect(document.body.textContent).not.toContain(privateFeedback);
    expect(screen.getByRole("button", { name: /Fictional saved milestone/ })).not.toHaveTextContent(privateFeedback);
    expect(screen.getByRole("textbox", { name: "Resultado esperado" })).toHaveValue(completed.expected_outcome);
    expect(screen.getByRole("textbox", { name: "Próxima acción explícita" })).toHaveValue(completed.next_action);
    fireEvent.click(reveal);
    expect(delivery().getByText(privateFeedback)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Fictional saved milestone/ })).not.toHaveTextContent(privateFeedback);
    fireEvent.click(screen.getByRole("button", { name: "Mostrar nombres" }));
    expect(screen.getByRole("button", { name: "Ocultar nombres" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /Fictional private client.*Activo/ })).toBeInTheDocument();
    expect(api.getClient).not.toHaveBeenCalled();
    expect(api.saveCommitment).not.toHaveBeenCalled();
    expect(api.recordDeliveryObservation).not.toHaveBeenCalled();
  });

  it("preserves explicit commitment and client editing without converting either save into delivery evidence", async () => {
    await renderDirectory(); editSaved();
    fireEvent.change(screen.getByRole("textbox", { name: "Próxima acción explícita" }), { target: { value: "A changed commitment action" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar compromiso" }));
    await waitFor(() => expect(api.saveCommitment).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ project_id: "alpha", state: "completed", next_action: "A changed commitment action" }), completed.id));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Entrega y seguimiento" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Cliente 1/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Notas confidenciales" })).toHaveValue(client.confidential_notes));
    expect(api.getClient).toHaveBeenCalledExactlyOnceWith(client.id);
    expect(screen.getByRole("textbox", { name: "Nota de SLA / criticidad" })).toHaveValue(client.sla_note);
    expect(api.saveClient).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Guardar cliente" }));
    await waitFor(() => expect(api.saveClient).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ display_name: client.display_name, confidential_notes: client.confidential_notes }), client.id));
    expect(api.getWorkIssues).not.toHaveBeenCalled();
    expect(api.getWorkIssue).not.toHaveBeenCalled();
    expect(api.recordDeliveryObservation).not.toHaveBeenCalled();
  });
});
