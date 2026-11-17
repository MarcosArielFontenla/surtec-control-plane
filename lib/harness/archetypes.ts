import Ajv2020 from "ajv/dist/2020.js";
import { parseDocument } from "yaml";
import schema from "../../schemas/project-archetypes.schema.json";
import { hash, readContained } from "./source";

interface ArchetypeDefinition {
  readonly verification: {
    readonly frontend: readonly ["test", "build"];
    readonly backend: readonly ["test", "build"];
  };
  readonly templates: readonly [".agents/templates/entity.spec.yaml", ".agents/templates/feature.tasks.md"];
  readonly execution_authority: "none";
}

export interface ProjectArchetype extends ArchetypeDefinition {
  readonly id: "personal@1";
  readonly registry_sha256: string;
}

interface ArchetypeRegistry {
  schema_version: 1;
  archetypes: Record<ProjectArchetype["id"], ArchetypeDefinition>;
}

const registryPath = "registry/project-archetypes.yml";
const validate = new Ajv2020({ strict: true, ownProperties: true }).compile<ArchetypeRegistry>(schema);

export function selectProjectArchetype(repoRoot: string, selection: unknown): ProjectArchetype {
  if (selection !== "personal@1") throw new Error("A supported versioned project archetype must be selected explicitly.");

  try {
    const bytes = readContained(repoRoot, registryPath);
    if (!bytes) throw new Error("missing registry");

    const document = parseDocument(bytes.toString("utf8"));
    if (document.errors.length || document.warnings.length) throw new Error("invalid registry YAML");

    const registry: unknown = document.toJS({ maxAliasCount: 0 });
    if (!validate(registry)) throw new Error("invalid registry schema");

    return { id: selection, ...registry.archetypes[selection], registry_sha256: hash(bytes) };
  } catch {
    throw new Error("Project archetype registry is unavailable or invalid.");
  }
}
