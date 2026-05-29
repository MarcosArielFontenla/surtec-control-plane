import { describe, it, expect } from "vitest";
import { buildQueryOptions, READ_ONLY_TOOLS } from "./claude";

describe("buildQueryOptions", () => {
  it("allows only Read/Grep/Glob and passes through cwd/systemPrompt", () => {
    const o = buildQueryOptions({ cwd: "/repo", systemPrompt: "sp", prompt: "p" });
    expect(o.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    expect(o.cwd).toBe("/repo");
    expect(o.systemPrompt).toBe("sp");
    expect(o.maxTurns).toBe(12);
    expect(READ_ONLY_TOOLS).toEqual(["Read", "Grep", "Glob"]);
  });

  it("canUseTool allows read tools and denies write/edit/bash", async () => {
    const o = buildQueryOptions({ cwd: "/repo", systemPrompt: "sp", prompt: "p" });
    const allow = await o.canUseTool("Read", { file: "x" });
    expect(allow.behavior).toBe("allow");
    for (const tool of ["Write", "Edit", "Bash", "WebFetch"]) {
      const deny = await o.canUseTool(tool, {});
      expect(deny.behavior).toBe("deny");
    }
  });
});
