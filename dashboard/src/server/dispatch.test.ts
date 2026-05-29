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
  writeFileSync(
    join(root, "registry", "projects.yml"),
    [
      "projects:",
      "  stock-control:",
      "    local_path: ~/dev/surtec/stock-control",
      "    status: active",
      "    allowed_agents:",
      "      - backend-engineer",
      "",
    ].join("\n"),
    "utf8",
  );
  process.env.SURTEC_STATE_DIR = join(root, "state");
});
afterEach(() => {
  delete process.env.SURTEC_STATE_DIR;
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
    expect(t.envelope.repo_path).toBe("~/dev/surtec/stock-control");
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
});
