import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadHarnessSource } from "../lib/harness/source";
import { managedGitArgs } from "../lib/security/managed-git.mjs";
import { localGitEnvironment } from "../lib/security/process-environments.mjs";

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

  it.each([false, true])("preserves exact canonical hashes after Git checkout with core.autocrlf=%s", (autocrlf) => {
    const canonical = loadHarnessSource(root);
    expect(canonical.status, canonical.reason ?? "").toBe("trusted");
    const fixture = mkdtempSync(join(tmpdir(), "surtec-harness-checkout-"));
    try {
      const source = join(fixture, "source"), checkout = join(fixture, "checkout");
      mkdirSync(source); mkdirSync(checkout);
      const paths = [".gitattributes", "registry/harness-sources.yml", canonical.registry!.source.manifest,
        ...canonical.manifest!.expected_entries.map((entry) => entry.path)];
      for (const path of paths) {
        const target = resolve(source, path);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(resolve(root, path), target);
      }
      const git = (args: string[]) => execFileSync("git", managedGitArgs([
        "-c", `core.autocrlf=${autocrlf}`, "-C", source, ...args,
      ], fixture), { windowsHide: true, encoding: "utf8", timeout: 10000,
        env: { ...localGitEnvironment(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } });
      git(["init", "--quiet"]);
      git(["add", "--all"]);
      git(["checkout-index", "--all", `--prefix=${checkout.replaceAll("\\", "/")}/`]);
      const exported = loadHarnessSource(checkout);
      expect(exported.status, exported.reason ?? "").toBe("trusted");
      expect(exported.fingerprint).toBe(canonical.fingerprint);
      for (const path of paths.filter((entry) => entry !== ".gitattributes"))
        expect(readFileSync(resolve(checkout, path)), path).toEqual(readFileSync(resolve(root, path)));
    } finally {
      const owned = resolve(fixture);
      if (dirname(owned) !== resolve(tmpdir()) || !basename(owned).startsWith("surtec-harness-checkout-") || lstatSync(owned).isSymbolicLink())
        throw new Error("Refusing cleanup outside the owned checkout fixture");
      rmSync(owned, { recursive: true, force: true });
    }
  }, 15000);
});
