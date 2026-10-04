import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { assertContextConfig, assertContextManifest, assertRoleRegistry, safeContextPath } from "./validation";
import type { AgentRoleRegistry, ContextConfig, ContextManifest } from "./types";

const registry = (): AgentRoleRegistry => parse(readFileSync("registry/agent-roles.yml", "utf8"));
const configuration = (): ContextConfig => parse(readFileSync("registry/context-policy.yml", "utf8"));
const fixture = (): ContextManifest => ({
  schema_version: 1, fingerprint: "a".repeat(64), project_id: "synthetic", role_id: "planner", agent_id: "tech-lead", task_kind: "analysis",
  sandbox: "read-only", tools: ["inspect"], approval_rules: ["publication"], budget: configuration().budgets.analysis!, limits: configuration().limits,
  sources: [{ id: "runtime-safety", layer: "runtime-safety", source_type: "policy", revision: "b".repeat(64), reason: "Mandatory policy", bytes: 20, lines: 2, sensitivity: "public" }],
  excluded_categories: ["confidential-notes"], selected_categories: [], omitted_sources: [], total_bytes: 30, total_lines: 3,
  routing: { work_scale: "trivial", action: "direct", review_depth: "focused", qa_required: false, reasons: ["Bounded analysis"], delegation: { admitted: false, executable: false, reasons: ["Trivial work"] } },
  testing: { mode: "functional", minimum_review_depth: "focused", runner_ids: [], commands: [], reasons: ["Default"], requires_red_evidence: false },
});
describe("Phase N contracts", () => {
  it("validates conservative role/config defaults and manifests", () => {
    expect(() => assertRoleRegistry(registry())).not.toThrow();
    expect(() => assertContextConfig(configuration())).not.toThrow();
    expect(() => assertContextManifest(fixture())).not.toThrow();
  });
  it("rejects duplicate roles and prompt-only capabilities", () => {
    const value = registry(); value.roles.push(value.roles[0]!);
    expect(() => assertRoleRegistry(value)).toThrow(/duplicate/);
    const incompatible = registry(); incompatible.roles[0]!.allowed_tool_capabilities.push("edit-authorized-scope");
    expect(() => assertRoleRegistry(incompatible)).toThrow(/Read-only/);
    expect(() => assertRoleRegistry({ ...registry(), extra: true })).toThrow(/Invalid/);
  });
  it.each(["../outside.md", "C:/private.txt", ".codex/auth.json", "state/task.json", ".env.local", "docs/../secret.md", "docs\\a.md", "/tmp/a", "docs/auth.json"])("rejects unsafe source %s", (path) => {
    expect(safeContextPath(path)).toBe(false);
    const value = configuration(); value.routes.push({ id: "unsafe", role_ids: [], task_kinds: [], affected_domains: [], paths: [path], required: true });
    expect(() => assertContextConfig(value)).toThrow(/Unsafe/);
  });
  it("rejects unsupported versions and context ceilings", () => {
    expect(() => assertContextConfig({ ...configuration(), schema_version: 2 })).toThrow();
    const value = configuration(); value.limits.max_lines = 2001;
    expect(() => assertContextConfig(value)).toThrow();
    const oversized = fixture(); oversized.total_lines = 501;
    expect(() => assertContextManifest(oversized)).toThrow(/budget/);
  });
  it("does not accept configured strict TDD without required stages", () => {
    const value = configuration(); value.testing.global.mode = "strict-tdd";
    expect(() => assertContextConfig(value)).toThrow(/RED/);
    value.testing.global.runner_ids = ["constructor"];
    expect(() => assertContextConfig(value)).toThrow(/Unknown/);
  });
  it("strictly validates probe sources, identities, bounds and trusted refactor justification", () => {
    const value = configuration(); value.runners.check = { command: "node probe.mjs", stage: "red", probe: { sources: [{ path: "test/probe.mjs", sha256: "a".repeat(64) }], assertion_ids: ["behavior"] } };
    expect(() => assertContextConfig(value)).not.toThrow();
    value.runners.check.probe!.sources[0]!.path = "../probe.mjs";
    expect(() => assertContextConfig(value)).toThrow(/Unsafe/);
    value.runners.check.probe!.sources[0]!.path = "test/probe.mjs";
    value.runners.check.probe!.assertion_ids.push("behavior"); expect(() => assertContextConfig(value)).toThrow(/Invalid/);
    value.runners.check.probe!.assertion_ids = ["behavior"];
    value.testing.no_refactor_justification = " "; expect(() => assertContextConfig(value)).toThrow(/Empty/);
    value.testing.no_refactor_justification = "x".repeat(501); expect(() => assertContextConfig(value)).toThrow(/Invalid/);
  });
  it("rejects inaccurate accounting and contradictory consent", () => {
    const value = fixture(); value.total_bytes = 1;
    expect(() => assertContextManifest(value)).toThrow(/accounting/);
    const consent = fixture(); consent.selected_categories = ["confidential-notes"];
    expect(() => assertContextManifest(consent)).toThrow(/consent/);
  });
  it("rejects reordered sources, duplicate identities and claimed delegation execution", () => {
    const value = fixture(); value.sources.unshift({ ...value.sources[0]!, id: "summary", layer: "resume", bytes: 0, lines: 0 });
    expect(() => assertContextManifest(value)).toThrow(/precedence/);
    const duplicate = fixture(); duplicate.sources.push(duplicate.sources[0]!);
    expect(() => assertContextManifest(duplicate)).toThrow(/duplicate/);
    const executable = fixture(); Object.assign(executable.routing.delegation, { executable: true });
    expect(() => assertContextManifest(executable)).toThrow();
  });
});
