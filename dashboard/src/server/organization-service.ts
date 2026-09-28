import { randomUUID } from "node:crypto";
import type { CompanyProfile, Objective, OrganizationSnapshot } from "../../../lib/organization";
import { readOrganizationSnapshot, setProjectObjectives, upsertCompanyProfile, upsertObjective, OrganizationStateError, UnsupportedOrganizationVersionError } from "../../../lib/state/organization";
import { organizationStatePath } from "../../../lib/state/paths";
import { validateCompanyProfile, validateObjective } from "../../../lib/state/validation";
import { describeValidation } from "../../../lib/state/validation";
import { isSafeIdentifier } from "../../../lib/security/identifiers";

export class OrganizationValidationError extends Error {}
export class OrganizationNotFoundError extends Error {}

export interface OrganizationService {
  read(): OrganizationSnapshot;
  saveCompany(profile: CompanyProfile): CompanyProfile;
  createObjective(input: Omit<Objective, "schema_version" | "id" | "company_id" | "project_ids" | "owner" | "last_reviewed_at">): Objective;
  saveObjective(objective: Objective): Objective;
  setProjectObjectives(projectId: string, objectiveIds: string[], primaryObjectiveId: string | null): OrganizationSnapshot["project_objectives"][string];
}

export function createOrganizationService(options: { statePath?: string; clock?: () => Date } = {}): OrganizationService {
  const statePath = options.statePath ?? organizationStatePath();
  const clock = options.clock ?? (() => new Date());
  const date = () => clock().toISOString().slice(0, 10);
  const snapshot = (): OrganizationSnapshot => readOrganizationSnapshot(statePath);

  return {
    read: snapshot,
    saveCompany(profile) {
      if (!validateCompanyProfile(profile)) throw new OrganizationValidationError(`company profile is invalid: ${describeValidation(validateCompanyProfile.errors)}`);
      return upsertCompanyProfile({ ...profile, last_reviewed_at: date() }, statePath);
    },
    createObjective(input) {
      const objective: Objective = {
        ...input,
        schema_version: 1,
        id: `objective-${randomUUID()}`,
        company_id: "surtec",
        project_ids: [],
        owner: "marcos",
        last_reviewed_at: date(),
      };
      if (!validateObjective(objective)) throw new OrganizationValidationError(`objective is invalid: ${describeValidation(validateObjective.errors)}`);
      snapshot();
      try { return upsertObjective(objective, statePath); }
      catch (error) {
        if (error instanceof UnsupportedOrganizationVersionError) throw error;
        if (error instanceof OrganizationStateError) throw new OrganizationValidationError(error.message);
        throw error;
      }
    },
    saveObjective(objective) {
      if (!snapshot().objectives.some((item) => item.id === objective.id)) throw new OrganizationNotFoundError("objective was not found");
      const updated = { ...objective, last_reviewed_at: date() };
      if (!validateObjective(updated)) throw new OrganizationValidationError(`objective is invalid: ${describeValidation(validateObjective.errors)}`);
      try { return upsertObjective(updated, statePath); }
      catch (error) {
        if (error instanceof UnsupportedOrganizationVersionError) throw error;
        if (error instanceof OrganizationStateError) throw new OrganizationValidationError(error.message);
        throw error;
      }
    },
    setProjectObjectives(projectId, objectiveIds, primaryObjectiveId) {
      if (!isSafeIdentifier(projectId)) throw new OrganizationValidationError("project ID is unsafe");
      if (objectiveIds.length > 100) throw new OrganizationValidationError("a project may link to at most 100 objectives");
      if (new Set(objectiveIds).size !== objectiveIds.length) throw new OrganizationValidationError("objective links must be unique");
      if (primaryObjectiveId && !objectiveIds.includes(primaryObjectiveId)) throw new OrganizationValidationError("primary objective must be among the selected objectives");
      const knownIds = new Set(snapshot().objectives.map((objective) => objective.id));
      if (objectiveIds.some((id) => !knownIds.has(id))) throw new OrganizationValidationError("one or more objectives were not found");
      return setProjectObjectives(projectId, objectiveIds, primaryObjectiveId, statePath);
    },
  };
}
