import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import agentResultSchema from "../../schemas/agent-result.schema.json";
import projectOverrideSchema from "../../schemas/project-status-override.schema.json";
import taskEnvelopeSchema from "../../schemas/task-envelope.schema.json";
import taskRecordSchema from "../../schemas/task-record.schema.json";
import taskEventSchema from "../../schemas/task-event.schema.json";
import projectProfileSchema from "../../schemas/project-profile.schema.json";
import portfolioProfilesSchema from "../../schemas/portfolio-profiles.schema.json";
import projectProfileV1Schema from "../../schemas/project-profile-v1.schema.json";
import portfolioProfilesV1Schema from "../../schemas/portfolio-profiles-v1.schema.json";
import signalSchema from "../../schemas/signal.schema.json";
import signalFeedSchema from "../../schemas/signal-feed.schema.json";
import signalHumanStateSchema from "../../schemas/signal-human-state.schema.json";
import signalActionSchema from "../../schemas/signal-action.schema.json";
import workSessionSchema from "../../schemas/work-session.schema.json";
import workSessionsSchema from "../../schemas/work-sessions.schema.json";
import workSessionStartSchema from "../../schemas/work-session-start.schema.json";
import workSessionActionSchema from "../../schemas/work-session-action.schema.json";
import clientRecordSchema from "../../schemas/client-record.schema.json";
import clientCommitmentSchema from "../../schemas/client-commitment.schema.json";
import clientPortfolioSchema from "../../schemas/client-portfolio.schema.json";
import clientInputSchema from "../../schemas/client-input.schema.json";
import commitmentInputSchema from "../../schemas/commitment-input.schema.json";
import companyProfileSchema from "../../schemas/company-profile.schema.json";
import objectiveSchema from "../../schemas/objective.schema.json";
import organizationStateSchema from "../../schemas/organization-state.schema.json";
import type { PortfolioProfilesDocument, ProjectProfile } from "../portfolio-profile";
import type { ClientCommitment, ClientPortfolioDocument, ClientRecord } from "../client-portfolio";
import type { CompanyProfile, Objective, OrganizationDocument } from "../organization";
import type { Signal, SignalAction, SignalFeed, SignalHumanStateDocument } from "../signals/types";
import type { ProjectStatusOverride, TaskEvent, TaskRecord, WorkSession } from "./types";

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
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth
      && Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59
      && Number.isFinite(Date.parse(value));
  },
});
ajv.addSchema(taskEnvelopeSchema);
ajv.addSchema(agentResultSchema);
ajv.addSchema(projectProfileSchema);
ajv.addSchema(projectProfileV1Schema);
ajv.addSchema(signalSchema);
ajv.addSchema(clientRecordSchema);
ajv.addSchema(clientCommitmentSchema);
ajv.addSchema(companyProfileSchema);
ajv.addSchema(objectiveSchema);

export const validateTaskRecord = ajv.compile(taskRecordSchema) as ValidateFunction<TaskRecord>;
export const validateTaskEvent = ajv.compile(taskEventSchema) as ValidateFunction<TaskEvent>;
export const validateProjectOverride = ajv.compile(projectOverrideSchema) as ValidateFunction<ProjectStatusOverride>;
export const validateProjectProfile = ajv.compile(projectProfileSchema) as ValidateFunction<ProjectProfile>;
export const validatePortfolioProfilesDocument = ajv.compile(portfolioProfilesSchema) as ValidateFunction<PortfolioProfilesDocument>;
export const validatePortfolioProfilesDocumentV1 = ajv.compile(portfolioProfilesV1Schema);
export const validateSignal = ajv.compile(signalSchema) as ValidateFunction<Signal>;
export const validateSignalFeed = ajv.compile(signalFeedSchema) as ValidateFunction<SignalFeed>;
export const validateSignalHumanStateDocument = ajv.compile(signalHumanStateSchema) as ValidateFunction<SignalHumanStateDocument>;
export const validateSignalAction = ajv.compile(signalActionSchema) as ValidateFunction<SignalAction>;
export const validateWorkSession = ajv.compile(workSessionSchema) as ValidateFunction<WorkSession>;
export const validateWorkSessionsDocument = ajv.compile(workSessionsSchema);
export const validateWorkSessionStart = ajv.compile(workSessionStartSchema);
export const validateWorkSessionAction = ajv.compile(workSessionActionSchema);
export const validateClientRecord = ajv.compile(clientRecordSchema) as ValidateFunction<ClientRecord>;
export const validateClientCommitment = ajv.compile(clientCommitmentSchema) as ValidateFunction<ClientCommitment>;
export const validateClientPortfolioDocument = ajv.compile(clientPortfolioSchema) as ValidateFunction<ClientPortfolioDocument>;
export const validateClientInput = ajv.compile(clientInputSchema);
export const validateCommitmentInput = ajv.compile(commitmentInputSchema);
export const validateCompanyProfile = ajv.compile(companyProfileSchema) as ValidateFunction<CompanyProfile>;
export const validateObjective = ajv.compile(objectiveSchema) as ValidateFunction<Objective>;
export const validateOrganizationDocument = ajv.compile(organizationStateSchema) as ValidateFunction<OrganizationDocument>;

export function describeValidation(errors: ErrorObject[] | null | undefined): string {
  return errors?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") ?? "invalid data";
}
