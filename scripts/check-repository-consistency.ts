import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function repositoryConsistencyErrors(settings: string, workflowSource: string): string[] {
  const errors: string[] = [];
  const branchMatches = [...settings.matchAll(/^Default branch:\s*`([A-Za-z0-9._/-]+)`\s*$/gm)];
  if (branchMatches.length !== 1) {
    errors.push("repository settings must document exactly one `Default branch: <branch>` value");
    return errors;
  }
  const defaultBranch = branchMatches[0]?.[1];
  if (!defaultBranch || defaultBranch.includes("..") || defaultBranch.startsWith("/") || defaultBranch.endsWith("/")) {
    errors.push("documented default branch is invalid");
    return errors;
  }

  let workflow: unknown;
  try {
    workflow = parse(workflowSource);
  } catch {
    errors.push("CI workflow is not valid YAML");
    return errors;
  }
  if (!isRecord(workflow) || !isRecord(workflow.on)) {
    errors.push("CI workflow must define an `on` trigger map");
    return errors;
  }
  const triggers = workflow.on;
  if (!Object.hasOwn(triggers, "pull_request") || triggers.pull_request === false) {
    errors.push("CI workflow must preserve the pull_request trigger");
  }
  if (!isRecord(triggers.push)) {
    errors.push("CI workflow must define a push trigger");
    return errors;
  }
  const branches = triggers.push.branches;
  if (!Array.isArray(branches) || branches.length !== 1 || branches[0] !== defaultBranch) {
    errors.push("CI push.branches must contain only the documented default branch `" + defaultBranch + "`");
  }
  return errors;
}

export function checkRepositoryConsistency(root = resolve(dirname(fileURLToPath(import.meta.url)), "..")): void {
  const settings = readFileSync(resolve(root, "docs/operations/repository-settings.md"), "utf8");
  const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
  const errors = repositoryConsistencyErrors(settings, workflow);
  if (errors.length > 0) throw new Error(errors.join("; "));
  console.log("Repository configuration is consistent with its documented default branch.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkRepositoryConsistency();
  } catch (error) {
    console.error(`Repository consistency check failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
