import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { selectProjectArchetype } from "./archetypes";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const definition = {
  verification: { frontend: ["test", "build"], backend: ["test", "build"] },
  templates: [".agents/templates/entity.spec.yaml", ".agents/templates/feature.tasks.md"],
  execution_authority: "none",
};
const registry = { schema_version: 1, archetypes: { "personal@1": definition } };
const invalidRegistry = "Project archetype registry is unavailable or invalid.";

function registryWithDefinition(overrides: Record<string, unknown>): string {
  return stringify({ ...registry, archetypes: { "personal@1": { ...definition, ...overrides } } });
}

describe("selectProjectArchetype", () => {
  let fixtureRoot: string | undefined;

  function createFixture(yaml?: string): string {
    fixtureRoot = mkdtempSync(join(tmpdir(), "surtec-archetype-"));
    if (yaml !== undefined) {
      mkdirSync(join(fixtureRoot, "registry"));
      writeFileSync(join(fixtureRoot, "registry", "project-archetypes.yml"), yaml);
    }
    return fixtureRoot;
  }

  afterEach(() => {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = undefined;
  });

  it("returns the checked-in recommendation and the SHA-256 of its source bytes", () => {
    const path = join(repoRoot, "registry", "project-archetypes.yml");
    const bytes = readFileSync(path);

    expect(selectProjectArchetype(repoRoot, "personal@1")).toEqual({
      id: "personal@1",
      ...definition,
      registry_sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(readFileSync(path)).toEqual(bytes);
  });

  it.each([undefined, null, "", "personal", "personal@2", "Personal@1", " personal@1 ", "team@1", "__proto__"])(
    "refuses a missing or unsupported selection (%s) before loading the registry",
    (selection) => {
      const root = createFixture();
      expect(() => selectProjectArchetype(root, selection)).toThrow("must be selected explicitly");
    },
  );

  it("refuses an explicit selection when the registry is missing", () => {
    expect(() => selectProjectArchetype(createFixture(), "personal@1")).toThrow(invalidRegistry);
  });

  it.each([
    ["malformed YAML", "archetypes: ["],
    ["duplicate keys", `${stringify(registry)}schema_version: 1\n`],
    ["YAML aliases", registryWithDefinition({
      verification: { frontend: definition.verification.frontend, backend: definition.verification.frontend },
    })],
    ["future registry versions", stringify({ ...registry, schema_version: 2 })],
    ["unreviewed archetypes", stringify({ ...registry, archetypes: { ...registry.archetypes, "team@1": { ...definition } } })],
    ["repository paths", stringify({ ...registry, repo_path: "../fixture" })],
    ["commands", registryWithDefinition({ command: "pnpm test" })],
    ["commands in intents", registryWithDefinition({
      verification: { ...definition.verification, frontend: ["pnpm test", "build"] },
    })],
    ["extra verification data", registryWithDefinition({
      verification: { ...definition.verification, smoke: ["test"] },
    })],
    ["granted authority", registryWithDefinition({ execution_authority: "write" })],
    ["unsafe templates", registryWithDefinition({ templates: ["../outside.md", definition.templates[1]] })],
    ["primer import", registryWithDefinition({ templates: [...definition.templates, "AGENTS.md"] })],
  ])("refuses %s", (_label, yaml) => {
    const root = createFixture(yaml);
    expect(() => selectProjectArchetype(root, "personal@1")).toThrow(invalidRegistry);
  });
});
