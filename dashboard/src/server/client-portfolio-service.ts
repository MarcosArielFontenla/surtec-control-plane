import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { ValidateFunction } from "ajv";
import { discoverProjects, DEFAULT_IGNORE } from "../../../lib/discover";
import type { ClientCommitment, ClientContextCategory, ClientContextShareAudit, ClientPortfolioDocument, ClientRecord, ClientSummary } from "../../../lib/client-portfolio";
import type { ProjectProfile } from "../../../lib/portfolio-profile";
import { isSafeIdentifier } from "../../../lib/security/identifiers";
import { redactText } from "../../../lib/security/redaction";
import type { TaskRecord, WorkSession } from "../../../lib/state/types";
import { listProjectProfiles } from "../../../lib/state/portfolio-profiles";
import { readClientPortfolio, mutateClientPortfolio } from "../../../lib/state/client-portfolio";
import { clientPortfolioPath } from "../../../lib/state/paths";
import { readTask as readTaskFromStore } from "../../../lib/state/store";
import { listWorkSessions } from "../../../lib/state/work-sessions";
import { describeValidation, validateClientInput, validateClientRecord, validateCommitmentInput, validateClientCommitment } from "../../../lib/state/validation";

const CONTEXT_CATEGORIES: ClientContextCategory[] = [
  "client-identity",
  "project-outcome",
  "active-commitments",
  "service-context",
  "confidential-notes",
];
const ACTIVE_COMMITMENT_STATES = new Set(["planned", "in-progress", "blocked"]);
const MAX_CONTEXT_CHARS = 8_000;

export class ClientPortfolioError extends Error {}
export class ClientPortfolioValidationError extends ClientPortfolioError {}
export class ClientPortfolioNotFoundError extends ClientPortfolioError {}
export class ClientPortfolioConflictError extends ClientPortfolioError {}

export interface ClientInput {
  display_name: string;
  status: ClientRecord["status"];
  criticality: ClientRecord["criticality"];
  sla_note: string | null;
  next_review_date: string | null;
  confidential_notes: string | null;
}

export type CommitmentInput = Omit<ClientCommitment, "id" | "created_at" | "updated_at">;

export interface ClientContextOptions {
  available: boolean;
  categories: ClientContextCategory[];
}

export interface ClientTaskContext {
  instructions: string;
  audit: ClientContextShareAudit;
}

export interface ClientPortfolioServiceDependencies {
  filePath?: string;
  clock?: () => Date;
  resolveProject?: (projectId: string) => boolean;
  readProfiles?: () => ProjectProfile[];
  readTask?: (taskId: string) => TaskRecord | null;
  readSessions?: () => WorkSession[];
}

function resolveDiscoveredProject(repoRoot: string, projectId: string): boolean {
  const root = process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
  const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((value) => value.trim()).filter(Boolean)];
  return discoverProjects(root, ignore).some((project) => project.id === projectId);
}

function normalizedOptionalText(value: string | null): string | null {
  const result = value?.trim() ?? "";
  return result || null;
}

function schemaError<T>(validator: ValidateFunction<T>, label: string): never {
  throw new ClientPortfolioValidationError(label + " is invalid: " + describeValidation(validator.errors));
}

function selectedCategories(value: unknown): ClientContextCategory[] {
  if (!Array.isArray(value) || value.some((category) => typeof category !== "string" || !CONTEXT_CATEGORIES.includes(category as ClientContextCategory))) {
    throw new ClientPortfolioValidationError("client context categories are invalid");
  }
  const categories = value as ClientContextCategory[];
  if (new Set(categories).size !== categories.length) throw new ClientPortfolioValidationError("client context categories must be unique");
  return CONTEXT_CATEGORIES.filter((category) => categories.includes(category));
}

function activeCommitment(commitment: ClientCommitment): boolean {
  return ACTIVE_COMMITMENT_STATES.has(commitment.state);
}

function safeContextText(value: string): string {
  return redactText(value).replace(/[\r\n\t]+/g, " ").trim();
}

function asClientInput(value: unknown): ClientInput {
  if (!validateClientInput(value)) schemaError(validateClientInput, "client");
  const input = value as unknown as ClientInput;
  return {
    display_name: input.display_name.trim(),
    status: input.status,
    criticality: input.criticality,
    sla_note: normalizedOptionalText(input.sla_note),
    next_review_date: input.next_review_date,
    confidential_notes: normalizedOptionalText(input.confidential_notes),
  };
}

function asCommitmentInput(value: unknown): CommitmentInput {
  if (!validateCommitmentInput(value)) schemaError(validateCommitmentInput, "commitment");
  const input = value as unknown as CommitmentInput;
  return {
    ...input,
    title: input.title.trim(),
    expected_outcome: input.expected_outcome.trim(),
    next_action: input.next_action.trim(),
  };
}

export function createClientPortfolioService(repoRoot: string, dependencies: ClientPortfolioServiceDependencies = {}) {
  const filePath = dependencies.filePath ?? clientPortfolioPath();
  const clock = dependencies.clock ?? (() => new Date());
  const resolveProject = dependencies.resolveProject ?? ((projectId: string) => resolveDiscoveredProject(repoRoot, projectId));
  const readProfiles = dependencies.readProfiles ?? listProjectProfiles;
  const readTask = dependencies.readTask ?? readTaskFromStore;
  const readSessions = dependencies.readSessions ?? listWorkSessions;

  function document(): ClientPortfolioDocument {
    return readClientPortfolio(filePath);
  }

  function profileFor(projectId: string): ProjectProfile | undefined {
    return readProfiles().find((profile) => profile.project_id === projectId);
  }

  function validateProjectAndClient(input: CommitmentInput, state: ClientPortfolioDocument): void {
    if (!isSafeIdentifier(input.project_id)) throw new ClientPortfolioValidationError("commitment project ID is invalid");
    if (!resolveProject(input.project_id)) throw new ClientPortfolioNotFoundError("commitment project is not a discovered local project");
    if (input.client_id === null) return;
    if (!state.clients[input.client_id]) throw new ClientPortfolioNotFoundError("linked client was not found");
    const profile = profileFor(input.project_id);
    if (profile?.kind !== "client" || profile.client_id !== input.client_id) {
      throw new ClientPortfolioValidationError("linked client must match the project's local client profile");
    }
  }

  function validateAssociations(input: CommitmentInput): void {
    for (const taskId of input.task_ids) {
      const task = readTask(taskId);
      if (!task) throw new ClientPortfolioNotFoundError("linked task " + taskId + " was not found");
      if (task.envelope.project !== input.project_id) throw new ClientPortfolioValidationError("linked tasks must belong to the commitment project");
    }
    const sessions = readSessions();
    for (const sessionId of input.session_ids) {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) throw new ClientPortfolioNotFoundError("linked session " + sessionId + " was not found");
      if (session.project_id !== input.project_id) throw new ClientPortfolioValidationError("linked sessions must belong to the commitment project");
    }
  }

  function contextOptions(projectId: string): ClientContextOptions {
    if (!isSafeIdentifier(projectId)) throw new ClientPortfolioValidationError("project ID is invalid");
    if (!resolveProject(projectId)) throw new ClientPortfolioNotFoundError("project is not a discovered local project");
    const profile = profileFor(projectId);
    if (!profile || profile.kind !== "client" || !profile.client_id) return { available: false, categories: [] };
    const state = document();
    const client = state.clients[profile.client_id];
    if (!client) return { available: false, categories: [] };
    const commitments = Object.values(state.commitments).filter((item) => item.project_id === projectId && item.client_id === client.id && activeCommitment(item));
    const categories: ClientContextCategory[] = ["client-identity"];
    if (profile.current_goal || profile.next_action) categories.push("project-outcome");
    if (commitments.length > 0) categories.push("active-commitments");
    categories.push("service-context");
    if (client.confidential_notes) categories.push("confidential-notes");
    return { available: true, categories };
  }

  return {
    listClients(): ClientSummary[] {
      const state = document();
      const profiles = readProfiles();
      return Object.values(state.clients).map((client) => ({
        id: client.id,
        display_name: client.display_name,
        status: client.status,
        criticality: client.criticality,
        project_ids: profiles.filter((profile) => profile.client_id === client.id).map((profile) => profile.project_id).sort(),
        next_review_date: client.next_review_date,
        active_commitment_count: Object.values(state.commitments).filter((item) => item.client_id === client.id && activeCommitment(item)).length,
      })).sort((left, right) => left.display_name.localeCompare(right.display_name) || left.id.localeCompare(right.id));
    },

    getClient(id: string): ClientRecord | null {
      if (!isSafeIdentifier(id)) throw new ClientPortfolioValidationError("client ID is invalid");
      return document().clients[id] ?? null;
    },

    createClient(value: unknown): ClientRecord {
      const input = asClientInput(value);
      const now = clock().toISOString();
      const client: ClientRecord = { id: "client-" + randomUUID(), ...input, created_at: now, updated_at: now };
      if (!validateClientRecord(client)) schemaError(validateClientRecord, "client");
      mutateClientPortfolio((state) => { state.clients[client.id] = client; }, filePath);
      return client;
    },

    updateClient(id: string, value: unknown): ClientRecord {
      if (!isSafeIdentifier(id)) throw new ClientPortfolioValidationError("client ID is invalid");
      const input = asClientInput(value);
      let updated: ClientRecord | null = null;
      mutateClientPortfolio((state) => {
        const current = state.clients[id];
        if (!current) throw new ClientPortfolioNotFoundError("client was not found");
        updated = { ...current, ...input, updated_at: clock().toISOString() };
        state.clients[id] = updated;
      }, filePath);
      return updated!;
    },

    listCommitments(): ClientCommitment[] {
      return Object.values(document().commitments).sort((left, right) =>
        (left.due_date ?? "9999-12-31").localeCompare(right.due_date ?? "9999-12-31")
        || left.priority - right.priority
        || left.id.localeCompare(right.id));
    },

    createCommitment(value: unknown): ClientCommitment {
      const input = asCommitmentInput(value);
      let created: ClientCommitment | null = null;
      const now = clock().toISOString();
      mutateClientPortfolio((state) => {
        validateProjectAndClient(input, state);
        validateAssociations(input);
        created = { id: "commitment-" + randomUUID(), ...input, created_at: now, updated_at: now };
        if (!validateClientCommitment(created)) schemaError(validateClientCommitment, "commitment");
        state.commitments[created.id] = created;
      }, filePath);
      return created!;
    },

    updateCommitment(id: string, value: unknown): ClientCommitment {
      if (!isSafeIdentifier(id)) throw new ClientPortfolioValidationError("commitment ID is invalid");
      const input = asCommitmentInput(value);
      let updated: ClientCommitment | null = null;
      mutateClientPortfolio((state) => {
        const current = state.commitments[id];
        if (!current) throw new ClientPortfolioNotFoundError("commitment was not found");
        validateProjectAndClient(input, state);
        validateAssociations(input);
        updated = { ...current, ...input, updated_at: clock().toISOString() };
        state.commitments[id] = updated;
      }, filePath);
      return updated!;
    },

    signalEvidence(): { clients: ClientRecord[]; commitments: ClientCommitment[] } {
      const state = document();
      return { clients: Object.values(state.clients), commitments: Object.values(state.commitments) };
    },

    contextOptions,

    buildTaskContext(projectId: string, value: unknown): ClientTaskContext | null {
      const categories = selectedCategories(value);
      if (categories.length === 0) return null;
      const options = contextOptions(projectId);
      if (!options.available) throw new ClientPortfolioConflictError("project has no registered client context");
      if (categories.some((category) => !options.categories.includes(category))) {
        throw new ClientPortfolioConflictError("one or more selected client context categories are unavailable");
      }

      const profile = profileFor(projectId)!;
      const state = document();
      const client = profile.client_id ? state.clients[profile.client_id] : undefined;
      if (!client) throw new ClientPortfolioConflictError("project client context is unavailable");
      const lines = ["Explicitly selected local client context. Use only for the authorized task scope."];
      if (categories.includes("client-identity")) lines.push("Client: " + safeContextText(client.display_name));
      if (categories.includes("project-outcome")) {
        lines.push("Project outcome:");
        if (profile.current_goal) lines.push("- Goal: " + safeContextText(profile.current_goal));
        if (profile.next_action) lines.push("- Current next action: " + safeContextText(profile.next_action));
      }
      if (categories.includes("active-commitments")) {
        lines.push("Active delivery commitments:");
        for (const commitment of Object.values(state.commitments)
          .filter((item) => item.project_id === projectId && item.client_id === client.id && activeCommitment(item))
          .sort((left, right) => (left.due_date ?? "9999-12-31").localeCompare(right.due_date ?? "9999-12-31"))) {
          lines.push("- " + safeContextText(commitment.title)
            + "; outcome: " + safeContextText(commitment.expected_outcome)
            + "; due: " + (commitment.due_date ?? "not set")
            + "; next action: " + safeContextText(commitment.next_action));
        }
      }
      if (categories.includes("service-context")) {
        lines.push("Operational criticality: " + client.criticality + ".");
        if (client.sla_note) lines.push("SLA note: " + safeContextText(client.sla_note));
        if (client.next_review_date) lines.push("Next client review: " + client.next_review_date);
      }
      if (categories.includes("confidential-notes")) {
        if (!client.confidential_notes) throw new ClientPortfolioConflictError("confidential notes are no longer available");
        lines.push("Confidential client notes (explicitly selected): " + safeContextText(client.confidential_notes));
      }
      const instructions = lines.join("\n");
      if (instructions.length > MAX_CONTEXT_CHARS) throw new ClientPortfolioConflictError("selected client context exceeds the 8,000 character limit");
      return { instructions, audit: { client_id: client.id, categories, shared_at: clock().toISOString() } };
    },
  };
}

export type ClientPortfolioService = ReturnType<typeof createClientPortfolioService>;
