import { describe, it, expect } from "vitest";
import { buildQueryOptions, READ_ONLY_TOOLS, WRITE_TOOLS } from "./claude";

const baseVerify = {
  cwd: "/w", systemPrompt: "s", prompt: "p",
  mode: "workspace-write-verify" as const,
  verifyCommands: ["pnpm install", "pnpm test"],
};

describe("buildQueryOptions (read-only)", () => {
  it("allows only Read/Grep/Glob and passes through cwd/systemPrompt", () => {
    const o = buildQueryOptions({ cwd: "/repo", systemPrompt: "sp", prompt: "p", mode: "read-only" });
    expect(o.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    expect(o.cwd).toBe("/repo");
    expect(o.systemPrompt).toBe("sp");
    expect(o.maxTurns).toBe(12);
    expect(READ_ONLY_TOOLS).toEqual(["Read", "Grep", "Glob"]);
  });

  it("disallows write + shell/exec tools in read-only mode", () => {
    const o = buildQueryOptions({ cwd: "/repo", systemPrompt: "sp", prompt: "p", mode: "read-only" });
    for (const tool of ["Write", "Edit", "MultiEdit", "Bash"]) {
      expect(o.disallowedTools).toContain(tool);
    }
  });

  it("canUseTool allows read tools and denies write/edit/bash", async () => {
    const o = buildQueryOptions({ cwd: "/repo", systemPrompt: "sp", prompt: "p", mode: "read-only" });
    expect((await o.canUseTool("Read", { file: "x" })).behavior).toBe("allow");
    for (const tool of ["Write", "Edit", "Bash", "WebFetch"]) {
      expect((await o.canUseTool(tool, {})).behavior).toBe("deny");
    }
  });
});

describe("buildQueryOptions (workspace-write-verify)", () => {
  it("verify mode allows Bash/BashOutput/KillBash and denies only NotebookEdit", () => {
    const q = buildQueryOptions(baseVerify);
    expect(q.allowedTools).toEqual(expect.arrayContaining(["Bash", "BashOutput", "KillBash", "Edit", "Write"]));
    expect(q.disallowedTools).toContain("NotebookEdit");
    expect(q.disallowedTools).not.toContain("Bash");
  });

  it("verify mode: canUseTool allows an exact allowlisted command (trimmed)", async () => {
    const q = buildQueryOptions(baseVerify);
    expect((await q.canUseTool("Bash", { command: "pnpm test" })).behavior).toBe("allow");
    expect((await q.canUseTool("Bash", { command: "  pnpm install  " })).behavior).toBe("allow");
  });

  it("verify mode: canUseTool denies non-listed, arg-extended, or chained commands", async () => {
    const q = buildQueryOptions(baseVerify);
    expect((await q.canUseTool("Bash", { command: "rm -rf /" })).behavior).toBe("deny");
    expect((await q.canUseTool("Bash", { command: "pnpm test --watch" })).behavior).toBe("deny");
    expect((await q.canUseTool("Bash", { command: "pnpm test && rm -rf ." })).behavior).toBe("deny");
    expect((await q.canUseTool("Bash", { command: "pnpm test; evil" })).behavior).toBe("deny");
    expect((await q.canUseTool("Bash", { command: "pnpm test | evil" })).behavior).toBe("deny");
    expect((await q.canUseTool("Bash", {})).behavior).toBe("deny");
  });

  it("verify mode: denies tools outside VERIFY_TOOLS", async () => {
    const q = buildQueryOptions(baseVerify);
    expect((await q.canUseTool("NotebookEdit", {})).behavior).toBe("deny");
    expect((await q.canUseTool("WebFetch", {})).behavior).toBe("deny");
  });

  it("verify mode bumps default maxTurns to 20", () => {
    expect(buildQueryOptions(baseVerify).maxTurns).toBe(20);
  });

  it("verify mode: allows BashOutput/KillBash ungated and denies empty Bash command", async () => {
    const q = buildQueryOptions(baseVerify);
    expect((await q.canUseTool("BashOutput", {})).behavior).toBe("allow");
    expect((await q.canUseTool("KillBash", {})).behavior).toBe("allow");
    expect((await q.canUseTool("Bash", { command: "   " })).behavior).toBe("deny");
  });

  it("plain workspace-write still denies Bash entirely", async () => {
    const q = buildQueryOptions({ cwd: "/w", systemPrompt: "s", prompt: "p", mode: "workspace-write" });
    expect(q.allowedTools).not.toContain("Bash");
    expect(q.disallowedTools).toContain("Bash");
    expect((await q.canUseTool("Bash", { command: "pnpm test" })).behavior).toBe("deny");
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
