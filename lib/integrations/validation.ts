import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import projectIntegrationsSchema from "../../schemas/project-integrations.schema.json";
import type { ProjectIntegrationsSnapshot } from "./types";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(projectIntegrationsSchema) as ValidateFunction<ProjectIntegrationsSnapshot>;

function validationDetail(errors: ErrorObject[] | null | undefined): string {
  return errors?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") ?? "invalid snapshot";
}

export function assertProjectIntegrationsSnapshot(value: unknown): asserts value is ProjectIntegrationsSnapshot {
  if (!validate(value)) throw new Error(`project integrations snapshot is invalid: ${validationDetail(validate.errors)}`);
}
