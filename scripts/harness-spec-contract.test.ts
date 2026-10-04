import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const templateSource = read(".agents/templates/entity.spec.yaml");
const schema = JSON.parse(read(".agents/contracts/spec.schema.json"));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

interface Spec {
  schema_version: number;
  name: string;
  entity: string;
  domains: string[];
  purpose: string;
  requirements: { id: string; description: string }[];
  constraints: string[];
  nonGoals: string[];
  designContract: {
    status: string;
    reviewedBy: string | null;
    approvedAt: string | null;
    acceptanceChecks: { id: string; requirementIds: string[]; description: string; command: string; expectedExitCode: number }[];
    checksWaiver: { reason: string; approvedBy: string; date: string } | null;
  };
  clarifications: { date: string; question: string; answer: string; affects: string }[];
  [key: string]: unknown;
}

const fresh = (): Spec => parse(templateSource) as Spec;
// Synthetic in-memory review metadata is test data, not an approved project spec.
function approved(): Spec {
  const spec = fresh();
  spec.name = "synthetic-feature";
  spec.entity = "SyntheticEntity";
  spec.domains = ["synthetic-domain"];
  spec.purpose = "Exercise the structural contract without side effects.";
  spec.requirements[0]!.description = "The synthetic check has a deterministic outcome.";
  spec.designContract.status = "approved";
  spec.designContract.reviewedBy = "synthetic-reviewer";
  spec.designContract.approvedAt = "2026-09-29T00:00:00Z";
  spec.designContract.acceptanceChecks[0]!.description = "Type checking reports its exit status.";
  spec.designContract.acceptanceChecks[0]!.command = "pnpm typecheck";
  return spec;
}

describe("H3 structural specification contract", () => {
  it("compiles a versioned strict schema and keeps the scaffold unapproved", () => {
    const spec = fresh();
    expect(schema.$id).toBe("urn:surtec:harness:spec:v1");
    expect(validate(spec), JSON.stringify(validate.errors)).toBe(true);
    expect(spec.designContract).toMatchObject({ status: "placeholder", reviewedBy: null, approvedAt: null, checksWaiver: null });
    expect(spec.designContract.acceptanceChecks.every((check) => check.command === "placeholder")).toBe(true);
  });

  it("allows proposed check drafts but rejects a proposal without checks", () => {
    const spec = fresh();
    spec.designContract.status = "proposed";
    expect(validate(spec)).toBe(true);
    spec.designContract.acceptanceChecks = [];
    expect(validate(spec)).toBe(false);
  });

  it("accepts a complete synthetic reviewed contract without executing its command", () => {
    expect(validate(approved()), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([null, "", "   "])("rejects approved metadata without a nonblank reviewer: %s", (reviewer) => {
    const spec = approved();
    spec.designContract.reviewedBy = reviewer;
    expect(validate(spec)).toBe(false);
  });

  it.each([null, "2026-09-29", "not-a-timestamp"])("rejects missing or malformed approval timestamp: %s", (timestamp) => {
    const spec = approved();
    spec.designContract.approvedAt = timestamp;
    expect(validate(spec)).toBe(false);
  });

  it.each(["placeholder", " PLACEHOLDER ", "PlaceHolder"])("rejects an unwaived placeholder command: %s", (command) => {
    const spec = approved();
    spec.designContract.acceptanceChecks[0]!.command = command;
    expect(validate(spec)).toBe(false);
  });

  it("rejects approval without checks or a waiver", () => {
    const spec = approved();
    spec.designContract.acceptanceChecks = [];
    expect(validate(spec)).toBe(false);
  });

  it("accepts a complete waiver for non-executable criteria but never manufactures a command", () => {
    const spec = approved();
    spec.designContract.acceptanceChecks = [];
    spec.designContract.checksWaiver = {
      reason: "Synthetic human-only visual preference, not an executable criterion.",
      approvedBy: "synthetic-reviewer", date: "2026-09-29",
    };
    expect(validate(spec)).toBe(true);
    expect(spec.designContract.acceptanceChecks).toEqual([]);
  });

  it.each(["reason", "approvedBy", "date"])("rejects a waiver missing %s", (field) => {
    const spec = approved();
    spec.designContract.acceptanceChecks = [];
    const waiver: Record<string, unknown> = { reason: "Synthetic waiver", approvedBy: "synthetic-reviewer", date: "2026-09-29" };
    delete waiver[field];
    expect(validate({ ...spec, designContract: { ...spec.designContract, checksWaiver: waiver } })).toBe(false);
  });

  it("rejects an incomplete waiver even when executable checks are present", () => {
    const spec = approved();
    expect(validate({ ...spec, designContract: { ...spec.designContract, checksWaiver: { reason: "Incomplete" } } })).toBe(false);
  });

  it("rejects unknown properties and future format versions", () => {
    const spec = approved();
    expect(validate({ ...spec, schema_version: 2 })).toBe(false);
    expect(validate({ ...spec, implicitApproval: true })).toBe(false);
    expect(validate({ ...spec, designContract: { ...spec.designContract, autoRun: true } })).toBe(false);
  });

  it("requires check coverage fields, nonblank commands and integer exit codes", () => {
    const spec = approved();
    const check = spec.designContract.acceptanceChecks[0]!;
    check.requirementIds = [];
    expect(validate(spec)).toBe(false);
    check.requirementIds = ["req-001", "req-001"];
    expect(validate(spec)).toBe(false);
    check.requirementIds = ["req-001"];
    check.command = "   ";
    expect(validate(spec)).toBe(false);
    check.command = "pnpm typecheck";
    check.expectedExitCode = 0.5;
    expect(validate(spec)).toBe(false);
  });

  it("requires complete clarification records rather than invented default answers", () => {
    const spec = fresh();
    spec.clarifications = [{ date: "2026-09-29", question: "Synthetic scope question?", answer: "Synthetic answer", affects: "req-001" }];
    expect(validate(spec)).toBe(true);
    spec.clarifications[0]!.answer = "";
    expect(validate(spec)).toBe(false);
  });

  it("keeps raw-marker, calendar, cross-reference and command authority guards explicitly outside structural validation", () => {
    const spec = approved();
    spec.purpose = "[NEEDS CLARIFICATION: synthetic unanswered scope?]";
    spec.designContract.approvedAt = "2026-99-99T00:00:00Z";
    spec.designContract.acceptanceChecks[0]!.requirementIds = ["req-missing"];
    spec.designContract.acceptanceChecks[0]!.command = "unreviewed-command --external-effect";
    // These typed values are not safe execution evidence. H4 must reject them
    // before any command is run; schema success alone is intentionally insufficient.
    expect(validate(spec)).toBe(true);
    expect(schema.$comment).toContain("command execution require H4 guards");
  });

  it("keeps the task template draft without fabricated dates or review metadata", () => {
    const taskSource = read(".agents/templates/feature.tasks.md");
    const metadata = parse(taskSource.match(/^---\n([\s\S]*?)\n---/)![1]!);
    expect(metadata).toMatchObject({ status: "draft", createdAt: null, reviewedBy: null, approvedAt: null });
  });
});
