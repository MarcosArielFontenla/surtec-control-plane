import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import agentResultSchema from "../../schemas/agent-result.schema.json";
import projectOverrideSchema from "../../schemas/project-status-override.schema.json";
import taskEnvelopeSchema from "../../schemas/task-envelope.schema.json";
import taskRecordSchema from "../../schemas/task-record.schema.json";
import taskEventSchema from "../../schemas/task-event.schema.json";
import type { ProjectStatusOverride, TaskEvent, TaskRecord } from "./types";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(taskEnvelopeSchema);
ajv.addSchema(agentResultSchema);

export const validateTaskRecord = ajv.compile(taskRecordSchema) as ValidateFunction<TaskRecord>;
export const validateTaskEvent = ajv.compile(taskEventSchema) as ValidateFunction<TaskEvent>;
export const validateProjectOverride = ajv.compile(projectOverrideSchema) as ValidateFunction<ProjectStatusOverride>;

export function describeValidation(errors: ErrorObject[] | null | undefined): string {
  return errors?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") ?? "invalid data";
}
