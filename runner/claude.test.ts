import { describe, it, expect } from "vitest";
import { buildQueryOptions, READ_ONLY_TOOLS, WRITE_TOOLS } from "./claude";

describe("buildQueryOptions (read-only)", () => {
  it("allows only Read/Grep/Glob and passes through cwd/systemPrompt", () => {
    const o = buildQueryOptions({ cwd: "/repo", systemPrompt: "sp", prompt: "p", mode: "read-only" });
    expect(o.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    expect(o.cwd).toBe("/repo");
    expect(o.systemPrompt).toBe("sp");
    expect(o.maxTurns).toBe(12);
    expect(READ_ONLY_TOOLS).toEqual(["Read", "Grep", "Glob"]);
  });

  it("canUseTool allows read tools and denies write/edit/bash", async () => {
    const o = buildQueryOptions({ cwd: "/repo", systemPrompt: "sp", prompt: "p", mode: "read-only" });
    expect((await o.canUseTool("Read", { file: "x" })).behavior).toBe("allow");
    for (const tool of ["Write", "Edit", "Bash", "WebFetch"]) {
      expect((await o.canUseTool(tool, {})).behavior).toBe("deny");
    }
  });
});

describe("buildQueryOptions (workspace-write)", () => {
  it("allows Read/Grep/Glob + Edit/Write/MultiEdit", () => {
    const o = buildQueryOptions({ cwd: "/repo", systemPrompt: "sp", prompt: "p", mode: "workspace-write" });
    expect(o.allowedTools).toEqual([...WRITE_TOOLS]);
    expect(WRITE_TOOLS).toEqual(["Read", "Grep", "Glob", "Edit", "Write", "MultiEdit"]);
  });

  it("canUseTool allows Edit/Write but STILL denies Bash", async () => {
    const o = buildQueryOptions({ cwd: "/repo", systemPrompt: "sp", prompt: "p", mode: "workspace-write" });
    expect((await o.canUseTool("Edit", {})).behavior).toBe("allow");
    expect((await o.canUseTool("Write", {})).behavior).toBe("allow");
    expect((await o.canUseTool("Bash", {})).behavior).toBe("deny");
    expect((await o.canUseTool("BashOutput", {})).behavior).toBe("deny");
  });

  it("disallows shell/exec tools in workspace-write mode", () => {
    const o = buildQueryOptions({ cwd: "/repo", systemPrompt: "sp", prompt: "p", mode: "workspace-write" });
    expect(o.disallowedTools).toContain("Bash");
    expect(o.disallowedTools).not.toContain("Edit");
  });
});
