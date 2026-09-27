import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import agentResultSchema from "../../schemas/agent-result.schema.json";
import projectOverrideSchema from "../../schemas/project-status-override.schema.json";
import taskEnvelopeSchema from "../../schemas/task-envelope.schema.json";
import taskRecordSchema from "../../schemas/task-record.schema.json";
import taskEventSchema from "../../schemas/task-event.schema.json";
import projectProfileSchema from "../../schemas/project-profile.schema.json";
import portfolioProfilesSchema from "../../schemas/portfolio-profiles.schema.json";
import type { PortfolioProfilesDocument, ProjectProfile } from "../portfolio-profile";
import type { ProjectStatusOverride, TaskEvent, TaskRecord } from "./types";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("date", {
  type: "string",
  validate: (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12) return false;
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    return day >= 1 && day <= daysInMonth;
  },
});
ajv.addSchema(taskEnvelopeSchema);
ajv.addSchema(agentResultSchema);
ajv.addSchema(projectProfileSchema);

export const validateTaskRecord = ajv.compile(taskRecordSchema) as ValidateFunction<TaskRecord>;
export const validateTaskEvent = ajv.compile(taskEventSchema) as ValidateFunction<TaskEvent>;
export const validateProjectOverride = ajv.compile(projectOverrideSchema) as ValidateFunction<ProjectStatusOverride>;
export const validateProjectProfile = ajv.compile(projectProfileSchema) as ValidateFunction<ProjectProfile>;
export const validatePortfolioProfilesDocument = ajv.compile(portfolioProfilesSchema) as ValidateFunction<PortfolioProfilesDocument>;

export function describeValidation(errors: ErrorObject[] | null | undefined): string {
  return errors?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") ?? "invalid data";
}
