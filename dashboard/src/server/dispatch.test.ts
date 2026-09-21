import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask, ValidationError } from "./dispatch";
import { listTasks } from "../../../lib/state/store";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-dispatch-"));
  mkdirSync(join(root, "registry"), { recursive: true });
  const projectsRoot = join(root, "projects");
  mkdirSync(join(projectsRoot, "stock-control", ".git"), { recursive: true });
  process.env.SURTEC_PROJECTS_ROOT = projectsRoot;
  writeFileSync(
    join(root, "registry", "agents.yml"),
    "agents:\n  - id: backend-engineer\n    name: Backend Engineer\n    type: engineering\n    description: Implements code.\n    default_sandbox: workspace-write\n    allowed_task_types: [bugfix]\n    requires_human_approval_for: [merge]\n",
    "utf8",
  );
  writeFileSync(
    join(root, "registry", "projects.yml"),
    [
      "projects:",
      "  stock-control:",
      "    local_path: ~/dev/surtec/stock-control",
      "    status: active",
      "    allowed_agents:",
      "      - backend-engineer",
      "    sandbox:",
      "      default: workspace-write",
      "    commands:",
      "      test: pnpm test",
      "",
    ].join("\n"),
    "utf8",
  );
  process.env.SURTEC_STATE_DIR = join(root, "state");
});
afterEach(() => {
  delete process.env.SURTEC_STATE_DIR;
  delete process.env.SURTEC_PROJECTS_ROOT;
  rmSync(root, { recursive: true, force: true });
});

describe("createTask", () => {
  it("records a queued read-only task with a built envelope", () => {
    const { id } = createTask(
      { project: "stock-control", agent: "backend-engineer", instructions: "Review the auth module." },
      root,
    );
    expect(id).toMatch(/^T-/);
    const tasks = listTasks();
    expect(tasks).toHaveLength(1);
    const t = tasks[0];
    expect(t.lifecycle).toBe("queued");
    expect(t.envelope.sandbox).toBe("read-only");
    expect(t.envelope.requires_human_approval).toBe(true);
    expect(t.envelope.project).toBe("stock-control");
    expect(t.envelope.agent).toBe("backend-engineer");
    expect(t.envelope.repo_path).toBe(join(root, "projects", "stock-control"));
    expect(t.envelope.source).toBe("dashboard");
  });

  it("rejects unknown project", () => {
    expect(() => createTask({ project: "nope", agent: "backend-engineer", instructions: "x" }, root)).toThrow(ValidationError);
  });

  it("rejects an agent not allowed for the project", () => {
    expect(() => createTask({ project: "stock-control", agent: "frontend-engineer", instructions: "x" }, root)).toThrow(ValidationError);
  });

  it("rejects empty instructions", () => {
    expect(() => createTask({ project: "stock-control", agent: "backend-engineer", instructions: "   " }, root)).toThrow(ValidationError);
  });

  it("records a workspace-write task with task_type implementation", () => {
    const { id } = createTask(
      { project: "stock-control", agent: "backend-engineer", instructions: "Implement X.", sandbox: "workspace-write" },
      root,
    );
    expect(id).toMatch(/^T-/);
    const t = listTasks().find((x) => x.envelope.id === id)!;
    expect(t.envelope.sandbox).toBe("workspace-write");
    expect(t.envelope.task_type).toBe("implementation");
  });

  it("defaults to read-only / analysis when sandbox is absent", () => {
    const { id } = createTask({ project: "stock-control", agent: "backend-engineer", instructions: "Look." }, root);
    const t = listTasks().find((x) => x.envelope.id === id)!;
    expect(t.envelope.sandbox).toBe("read-only");
    expect(t.envelope.task_type).toBe("analysis");
  });

  it("rejects an invalid sandbox value", () => {
    expect(() =>
      createTask({ project: "stock-control", agent: "backend-engineer", instructions: "x", sandbox: "danger" } as never, root),
    ).toThrow(ValidationError);
  });

  it("rejects self_verify on a read-only task", () => {
    expect(() =>
      createTask({ project: "stock-control", agent: "backend-engineer", instructions: "x", sandbox: "read-only", self_verify: true }, root),
    ).toThrow(/self_verify requires/i);
  });

  it("sets self_verify on a workspace-write envelope", () => {
    const { id } = createTask({ project: "stock-control", agent: "backend-engineer", instructions: "x", sandbox: "workspace-write", self_verify: true }, root);
    const t = listTasks().find((x) => x.envelope.id === id)!;
    expect(t.envelope.self_verify).toBe(true);
  });

  it("defaults self_verify to false when omitted", () => {
    const { id } = createTask({ project: "stock-control", agent: "backend-engineer", instructions: "x", sandbox: "workspace-write" }, root);
    const t = listTasks().find((x) => x.envelope.id === id)!;
    expect(t.envelope.self_verify).toBe(false);
  });
});
