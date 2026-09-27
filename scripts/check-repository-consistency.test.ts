import { describe, expect, it } from "vitest";
import { repositoryConsistencyErrors } from "./check-repository-consistency";

const settings = "# Repository settings checkpoint\n\nDefault branch: `master`\n";
const matchingWorkflow = `name: CI
on:
  pull_request:
  push:
    branches: [master]
permissions:
  contents: read
`;

describe("repository consistency check", () => {
  it("accepts a push trigger matching the documented default branch", () => {
    expect(repositoryConsistencyErrors(settings, matchingWorkflow)).toEqual([]);
  });

  it("detects default-branch drift in the push trigger", () => {
    expect(repositoryConsistencyErrors(settings, matchingWorkflow.replace("[master]", "[main]")))
      .toContain("CI push.branches must contain only the documented default branch `master`");
  });

  it("requires pull-request checks to remain enabled", () => {
    expect(repositoryConsistencyErrors(settings, matchingWorkflow.replace("  pull_request:\n", "")))
      .toContain("CI workflow must preserve the pull_request trigger");
    expect(repositoryConsistencyErrors(settings, matchingWorkflow.replace("  pull_request:\n", "  pull_request: false\n")))
      .toContain("CI workflow must preserve the pull_request trigger");
  });

  it("rejects ambiguous default-branch documentation", () => {
    expect(repositoryConsistencyErrors(`${settings}Default branch: ` + "`main`\n", matchingWorkflow))
      .toContain("repository settings must document exactly one `Default branch: <branch>` value");
  });
});
