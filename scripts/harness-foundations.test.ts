import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const primer = read("AGENTS.md");
const policy = read(".agents/policies/project.md");
const routing = read(".agents/orchestration/ROUTING.md");
const registry = read(".agents/AGENTS.md");
const runtime = read("docs/architecture/execution-runtime.md");

describe("Harness foundations", () => {
  it("keeps a compact primer with a distinct registry and mandatory complete reads", () => {
    expect(primer.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(40);
    const match = primer.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(match).not.toBeNull();
    const metadata = parse(match![1]!);
    expect(metadata.role).toBe("session-primer");
    expect(metadata.registry).toBe(".agents/AGENTS.md");
    expect(primer).toContain("project.md) completely for every task");
    expect(primer).toContain("ROUTING.md) completely");
    expect(primer).toContain("Read each selected skill completely");
    expect(registry).toContain("role: artifact-registry");
  });

  it("preserves the non-negotiable ownership and execution safeguards", () => {
    for (const rule of [
      "Do not modify external project repositories unless the user explicitly requests it",
      "Never deploy, merge, push, or send external messages without explicit authorization",
      "Treat existing and untracked user changes as user-owned",
      "Never store credentials, tokens, auth files, or private keys",
      "Never use a full-access sandbox for dispatched tasks",
      "Automated tests must use protocol fakes and must not make paid model calls",
      "Real runtime smoke tests must be explicit opt-in operations",
      "Invalid or missing structured agent output must fail safely as `needs-review`",
      "Do not request or persist raw chain-of-thought",
      "Enforce limits in code, sandbox configuration, approvals, and registry policy",
      "Stop after each authorized phase for local user validation",
    ]) expect(policy).toContain(rule);
  });

  it("preserves the product stack and sole stable runtime outside the portable core", () => {
    for (const rule of [
      "TypeScript ESM on Node.js 20 or newer",
      "React and Vite provide the dashboard UI",
      "Hono provides the local API",
      "Codex App Server over local `stdio` JSON-RPC is the only agent execution runtime",
      "current official OpenAI documentation as protocol sources of truth",
      "Do not enable experimental protocol fields without an ADR",
      "Keep the model configurable; do not hardcode a model name",
    ]) expect(runtime).toContain(rule);
    expect(policy).toContain("read it before any runtime, protocol, dispatch, sandbox, approval, or verification change");
    for (const core of [policy, routing, registry]) expect(core).not.toMatch(/\b(?:Codex|OpenAI|Claude|Cursor|Copilot)\b/i);
  });

  it("routes every documented artifact to an existing repository file", () => {
    for (const document of [primer, policy, routing, registry, runtime]) {
      const codePaths = [...document.matchAll(/`((?:\.agents\/|docs\/)[^`]+\.(?:md|ya?ml))`/g)];
      for (const [, path] of codePaths) expect(existsSync(resolve(root, path!)), path).toBe(true);
    }
    for (const path of [".agents/policies/project.md", ".agents/orchestration/ROUTING.md", ".agents/AGENTS.md"])
      expect(existsSync(resolve(root, path)), path).toBe(true);
  });

  it("preserves isolated real API/browser acceptance and the delivery contract", () => {
    expect(policy).toContain("pnpm smoke:local:playwright");
    expect(policy).toContain("never the user's normal `state/` or sibling projects");
    expect(policy).toContain("genuinely subjective choices");
    for (const command of ["pnpm install --frozen-lockfile", "pnpm test", "pnpm typecheck", "pnpm build"])
      expect(policy).toContain(command);
    const delivery = policy.split("## Delivery format")[1]!;
    expect([...delivery.matchAll(/^\d\. /gm)]).toHaveLength(9);
  });

  it("does not claim pending systems or historical approvals are operational", () => {
    expect(primer).toContain("structural validity never proves human approval or grants execution authority");
    expect(routing).toContain("Do not retroactively block historical phases");
    expect(routing).toContain("Multi-agent orchestration, skill drift evaluation, and telemetry are inactive");
    expect(read("docs/architecture/harness-v5.2-adaptation.md")).toContain("not retrospective approval");
  });
});
