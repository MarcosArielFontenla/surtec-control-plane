import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { isSafeIdentifier } from "../security/identifiers";
import { MAX_OBJECTIVE_DEPTH, type CompanyProfile, type Objective, type OrganizationDocument, type OrganizationSnapshot, type ProjectObjectiveLinks } from "../organization";
import { organizationStatePath } from "./paths";
import { withStateLock } from "./store";
import { describeValidation, validateCompanyProfile, validateObjective, validateOrganizationDocument } from "./validation";

export class OrganizationStateError extends Error {}
export class UnsupportedOrganizationVersionError extends OrganizationStateError {
  constructor(readonly version: number) { super(`unsupported organization schema version: ${version}`); }
}

const emptyDocument = (): OrganizationDocument => ({
  schema_version: 1,
  company: {
    schema_version: 1,
    id: "surtec",
    display_name: "SURTEC",
    mission: null,
    operating_principles: [],
    active_objective_ids: [],
    last_reviewed_at: null,
  },
  objectives: {},
  project_objectives: {},
});

function objectiveFromRecord(record: OrganizationDocument["objectives"][string], projectIds: string[] = []): Objective {
  return { ...record, project_ids: projectIds };
}

function validateInvariants(value: OrganizationDocument): void {
  if (!validateOrganizationDocument(value)) throw new OrganizationStateError(`organization state is invalid: ${describeValidation(validateOrganizationDocument.errors)}`);
  if (Object.keys(value.objectives).length > 500) throw new OrganizationStateError("organization state exceeds the 500-objective limit");
  const objectiveIds = new Set(Object.keys(value.objectives));
  for (const [id, objective] of Object.entries(value.objectives)) {
    if (!isSafeIdentifier(id) || id !== objective.id || !validateObjective(objectiveFromRecord(objective))) {
      throw new OrganizationStateError("organization objective keys or records are invalid");
    }
    if (objective.parent_objective_id && !objectiveIds.has(objective.parent_objective_id)) {
      throw new OrganizationStateError("objective parent does not exist");
    }
    const seen = new Set<string>([id]);
    let parentId = objective.parent_objective_id;
    let depth = 1;
    while (parentId) {
      if (seen.has(parentId)) throw new OrganizationStateError("objective ancestry contains a cycle");
      seen.add(parentId);
      depth += 1;
      if (depth > MAX_OBJECTIVE_DEPTH) throw new OrganizationStateError(`objective ancestry exceeds ${MAX_OBJECTIVE_DEPTH} levels`);
      parentId = value.objectives[parentId]?.parent_objective_id ?? null;
    }
  }

  const expectedActive = Object.values(value.objectives).filter((objective) => objective.status === "active")
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id)).map((objective) => objective.id);
  if (expectedActive.length > 100) throw new OrganizationStateError("organization state exceeds the 100-active-objective limit");
  if (JSON.stringify(value.company.active_objective_ids) !== JSON.stringify(expectedActive)) {
    throw new OrganizationStateError("company active objective index is inconsistent");
  }

  const projectsByObjective = new Map<string, string[]>();
  for (const [projectId, link] of Object.entries(value.project_objectives)) {
    if (!isSafeIdentifier(projectId) || link.objective_ids.some((id) => !objectiveIds.has(id))) {
      throw new OrganizationStateError("project objective links contain an unknown identifier");
    }
    if (link.primary_objective_id && !link.objective_ids.includes(link.primary_objective_id)) {
      throw new OrganizationStateError("primary objective must be linked to its project");
    }
    for (const id of link.objective_ids) projectsByObjective.set(id, [...(projectsByObjective.get(id) ?? []), projectId]);
  }
  for (const [id, objective] of Object.entries(value.objectives)) {
    const fullObjective = objectiveFromRecord(objective, (projectsByObjective.get(id) ?? []).sort());
    if (!validateObjective(fullObjective)) throw new OrganizationStateError(`organization objective is invalid: ${describeValidation(validateObjective.errors)}`);
  }
}

function readDocument(filePath: string): OrganizationDocument {
  if (!existsSync(filePath)) return emptyDocument();
  let value: unknown;
  try { value = JSON.parse(readFileSync(filePath, "utf8")); }
  catch { throw new OrganizationStateError("organization state contains invalid JSON"); }
  const version = value && typeof value === "object" ? (value as { schema_version?: unknown }).schema_version : undefined;
  if (typeof version === "number" && version > 1) throw new UnsupportedOrganizationVersionError(version);
  if (!validateOrganizationDocument(value)) throw new OrganizationStateError(`organization state is invalid: ${describeValidation(validateOrganizationDocument.errors)}`);
  const document = value as OrganizationDocument;
  validateInvariants(document);
  return document;
}

function writeDocumentAtomic(filePath: string, document: OrganizationDocument): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(document, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* only the unique temporary file created above is eligible for cleanup */ }
    throw error;
  }
}

function normalizeActiveIds(document: OrganizationDocument): void {
  document.company.active_objective_ids = Object.values(document.objectives)
    .filter((objective) => objective.status === "active")
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
    .map((objective) => objective.id);
}

export function readOrganizationDocument(filePath: string = organizationStatePath()): OrganizationDocument {
  return readDocument(filePath);
}

export function listOrganizationObjectives(filePath: string = organizationStatePath()): Objective[] {
  const document = readDocument(filePath);
  const projectsByObjective = new Map<string, string[]>();
  for (const [projectId, links] of Object.entries(document.project_objectives)) {
    for (const objectiveId of links.objective_ids) projectsByObjective.set(objectiveId, [...(projectsByObjective.get(objectiveId) ?? []), projectId]);
  }
  return Object.values(document.objectives).map((objective) => objectiveFromRecord(objective, (projectsByObjective.get(objective.id) ?? []).sort()))
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}

export function readOrganizationSnapshot(filePath: string = organizationStatePath()): OrganizationSnapshot {
  const document = readDocument(filePath);
  const projectsByObjective = new Map<string, string[]>();
  for (const [projectId, links] of Object.entries(document.project_objectives)) {
    for (const objectiveId of links.objective_ids) projectsByObjective.set(objectiveId, [...(projectsByObjective.get(objectiveId) ?? []), projectId]);
  }
  const objectives = Object.values(document.objectives).map((objective) => objectiveFromRecord(objective, (projectsByObjective.get(objective.id) ?? []).sort()))
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  return { company: document.company, objectives, project_objectives: document.project_objectives };
}

export function upsertCompanyProfile(profile: CompanyProfile, filePath: string = organizationStatePath()): CompanyProfile {
  if (!validateCompanyProfile(profile)) throw new OrganizationStateError(`company profile is invalid: ${describeValidation(validateCompanyProfile.errors)}`);
  if (profile.id !== "surtec") throw new OrganizationStateError("only the SURTEC company profile is supported");
  const stateRoot = dirname(dirname(filePath));
  return withStateLock("organization", () => {
    const document = readDocument(filePath);
    document.company = { ...profile, active_objective_ids: document.company.active_objective_ids };
    writeDocumentAtomic(filePath, document);
    return document.company;
  }, join(stateRoot, "locks"));
}

export function upsertObjective(objective: Objective, filePath: string = organizationStatePath()): Objective {
  if (!validateObjective(objective)) throw new OrganizationStateError(`objective is invalid: ${describeValidation(validateObjective.errors)}`);
  if (!isSafeIdentifier(objective.id)) throw new OrganizationStateError("objective ID is unsafe");
  const stateRoot = dirname(dirname(filePath));
  return withStateLock("organization", () => {
    const document = readDocument(filePath);
    const previous = document.objectives[objective.id];
    if (!previous && objective.project_ids.length > 0) throw new OrganizationStateError("new objectives must be linked to projects in a separate operation");
    const record: OrganizationDocument["objectives"][string] = {
      schema_version: 1,
      id: objective.id,
      company_id: "surtec",
      title: objective.title.trim(),
      desired_outcome: objective.desired_outcome.trim(),
      success_criteria: objective.success_criteria.map((item) => item.trim()),
      status: objective.status,
      horizon: objective.horizon,
      priority: objective.priority,
      target_date: objective.target_date,
      parent_objective_id: objective.parent_objective_id,
      owner: "marcos",
      last_reviewed_at: objective.last_reviewed_at,
    };
    document.objectives[objective.id] = record;
    normalizeActiveIds(document);
    validateInvariants(document);
    writeDocumentAtomic(filePath, document);
    const projectIds = Object.entries(document.project_objectives).filter(([, links]) => links.objective_ids.includes(objective.id)).map(([id]) => id).sort();
    return objectiveFromRecord(record, projectIds);
  }, join(stateRoot, "locks"));
}

export function setProjectObjectives(
  projectId: string,
  objectiveIds: string[],
  primaryObjectiveId: string | null,
  filePath: string = organizationStatePath(),
): ProjectObjectiveLinks {
  if (!isSafeIdentifier(projectId)) throw new OrganizationStateError("project ID is unsafe");
  if (new Set(objectiveIds).size !== objectiveIds.length) throw new OrganizationStateError("objective links must be unique");
  if (objectiveIds.length > 100) throw new OrganizationStateError("a project may link to at most 100 objectives");
  const stateRoot = dirname(dirname(filePath));
  return withStateLock("organization", () => {
    const document = readDocument(filePath);
    if (objectiveIds.some((id) => !document.objectives[id])) throw new OrganizationStateError("one or more objectives were not found");
    if (primaryObjectiveId && !objectiveIds.includes(primaryObjectiveId)) throw new OrganizationStateError("primary objective must be among the selected objectives");
    if (objectiveIds.length === 0) delete document.project_objectives[projectId];
    else document.project_objectives[projectId] = { objective_ids: [...objectiveIds].sort(), primary_objective_id: primaryObjectiveId };
    validateInvariants(document);
    writeDocumentAtomic(filePath, document);
    return document.project_objectives[projectId] ?? { objective_ids: [], primary_objective_id: null };
  }, join(stateRoot, "locks"));
}
