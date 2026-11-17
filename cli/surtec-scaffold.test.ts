import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScaffoldOperationService } from "../lib/harness/scaffold-operation";
import { runScaffoldCli } from "./surtec-scaffold";

vi.mock("../lib/harness/scaffold-operation", () => ({ createScaffoldOperationService: vi.fn() }));

const id = "4d7d813b-5524-478a-ace0-81846e2b7bd0";
const applyDigest = "a".repeat(64);
const rollbackDigest = "b".repeat(64);
const service = { preview: vi.fn(), apply: vi.fn(), status: vi.fn(), rollback: vi.fn() };
type Confirm = (offer: { apply_digest: string; rollback_digest: string }) => Promise<{ digest: string; exclusive: boolean } | null>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createScaffoldOperationService).mockReturnValue(service as unknown as ReturnType<typeof createScaffoldOperationService>);
});

function io(tty = false, answer?: (prompt: string) => string | null) {
  const stdin = Object.assign(new PassThrough(), { isTTY: tty });
  const stdout = new PassThrough();
  const stderr = Object.assign(new PassThrough(), { isTTY: tty });
  let result = "", displayed = "", replied = false;
  stdout.on("data", (chunk) => { result += chunk.toString(); });
  stderr.on("data", (chunk) => {
    displayed += chunk.toString();
    const expected = /Type exactly "((?:apply|rollback) [a-f0-9]{64})"/.exec(displayed)?.[1];
    if (!replied && expected && answer) {
      replied = true;
      const response = answer(expected);
      queueMicrotask(() => { if (response === null) stdin.end(); else stdin.write(response + "\n"); });
    }
  });
  return { stdin, stdout, stderr, result: () => JSON.parse(result), output: () => result, displayed: () => displayed };
}

describe("scaffold CLI", () => {
  it("dispatches explicit read-only commands on pipes with parseable output and outcome exit codes", async () => {
    service.preview.mockReturnValue({ status: "available", apply_digest: applyDigest });
    service.status.mockReturnValue({ status: "needs-review", operation_id: id });
    const preview = io();
    expect(await runScaffoldCli(["preview", "fixture", "personal@1"], preview)).toBe(0);
    expect(preview.result()).toEqual({ status: "available", apply_digest: applyDigest });
    expect(service.preview).toHaveBeenCalledWith({ projectId: "fixture", selection: "personal@1" });
    expect(preview.displayed()).toBe("");
    const state = io();
    expect(await runScaffoldCli(["status", id], state)).toBe(1);
    expect(state.result()).toEqual({ status: "needs-review", operation_id: id });
  });

  it.each([
    ["apply", "fixture", "personal@1", "--yes"],
    ["preview", "fixture", "personal@2"],
    ["preview", "../other", "personal@1"],
    ["rollback", "../other"],
    ["apply", "fixture"],
  ])("rejects unreviewed arguments %j before resolving any service", async (...args) => {
    const terminal = io(true);
    expect(await runScaffoldCli(args, terminal)).toBe(2);
    expect(terminal.displayed()).toContain("Run from the Surtec Control Plane root");
    expect(createScaffoldOperationService).not.toHaveBeenCalled();
  });

  it("shares usage with --help and refuses non-interactive mutations before resolving any repository", async () => {
    const help = io();
    expect(await runScaffoldCli(["--help"], help)).toBe(0);
    expect(help.output()).toContain("cli/surtec-scaffold.ts rollback <operation-id>");
    for (const args of [["apply", "fixture", "personal@1"], ["rollback", id]]) {
      const piped = io();
      piped.stdin.end(`apply ${applyDigest}\n`);
      expect(await runScaffoldCli(args, piped)).toBe(1);
      expect(piped.result()).toEqual({ status: "refused", reason: "interactive-terminal-required" });
    }
    expect(createScaffoldOperationService).not.toHaveBeenCalled();
  });

  it.each(["apply", "rollback"] as const)("shows the exact %s plan on stderr and passes the matching live approval", async (action) => {
    const offer = { apply_digest: applyDigest, rollback_digest: rollbackDigest, paths: [".agents/templates/entity.spec.yaml"] };
    const digest = action === "apply" ? applyDigest : rollbackDigest;
    const terminal = io(true, (expected) => expected);
    service[action].mockImplementation(async (_input, confirm: Confirm) => {
      expect(await confirm(offer)).toEqual({ digest, exclusive: true });
      return { status: action === "apply" ? "applied" : "rolled-back", operation_id: id };
    });
    const args = action === "apply" ? ["apply", "fixture", "personal@1"] : ["rollback", id];
    expect(await runScaffoldCli(args, terminal)).toBe(0);
    expect(terminal.displayed()).toContain(JSON.stringify({ action, plan: offer }, null, 2));
    expect(terminal.displayed()).toContain("confirm exclusive access until the operation ends");
    expect(terminal.result().operation_id).toBe(id);
  });

  it.each(["wrong verb", "EOF", "interrupt"])("cancels approval on %s", async (condition) => {
    const terminal = io(true, () => condition === "EOF" ? null : condition === "interrupt" ? "\u0003" : `apply ${rollbackDigest}`);
    service.rollback.mockImplementation(async (_id, confirm: Confirm) => {
      expect(await confirm({ apply_digest: applyDigest, rollback_digest: rollbackDigest })).toBeNull();
      return { status: "refused", reason: "not-approved" };
    });
    expect(await runScaffoldCli(["rollback", id], terminal)).toBe(1);
    expect(terminal.result()).toEqual({ status: "refused", reason: "not-approved" });
  });

  it("blocks accidentally tracked state within the control-plane checkout", async () => {
    const terminal = io(true);
    const repoRoot = resolve("synthetic-control");
    expect(await runScaffoldCli(["apply", "fixture", "personal@1"], {
      ...terminal, repoRoot, environment: { SURTEC_STATE_DIR: resolve(repoRoot, "registry") },
    })).toBe(1);
    expect(terminal.result()).toEqual({ status: "refused", reason: "state-root-outside-ignored-state" });
    expect(createScaffoldOperationService).not.toHaveBeenCalled();
  });
});
