import Ajv2020 from "ajv/dist/2020.js";
import manifestSchema from "../../schemas/harness-manifest.schema.json";
import sourceSchema from "../../schemas/harness-source-registry.schema.json";
import profileSchema from "../../schemas/project-harness-profile.schema.json";
import profilesSchema from "../../schemas/harness-profiles.schema.json";
import type { HarnessManifest, HarnessSourceRegistry, ProjectHarnessProfile, HarnessProfilesDocument, TestingPolicy } from "./types";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const manifest = ajv.compile<HarnessManifest>(manifestSchema);
const registry = ajv.compile<HarnessSourceRegistry>(sourceSchema);
const profile = ajv.compile<ProjectHarnessProfile>(profileSchema);
const profiles = ajv.compile<HarnessProfilesDocument>(profilesSchema);
const safePath = (path: string) => /^[^\\:]+$/.test(path) && !path.startsWith("/") && path.split("/").every((part) => part && part !== "." && part !== "..");
const validTime = (value: string) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value.slice(0, 19));
function testing(policy: TestingPolicy): void {
  if ((policy.mode === "strict-tdd" && (!policy.runner_id || !policy.requires_red_evidence))
    || (policy.mode === "functional" && policy.requires_red_evidence)) throw new Error("invalid testing policy");
}
export function assertManifest(value: unknown): asserts value is HarnessManifest {
  if (!manifest(value)) throw new Error("invalid harness manifest");
  const paths = new Set<string>();
  for (const entry of value.expected_entries) {
    if (!safePath(entry.path) || paths.has(entry.path) || !value.capabilities[entry.capability]) throw new Error("invalid manifest entries");
    paths.add(entry.path);
  }
}
export function assertSourceRegistry(value: unknown): asserts value is HarnessSourceRegistry {
  if (!registry(value) || !safePath(value.source.manifest)) throw new Error("invalid trusted source registry");
  for (const config of Object.values(value.projects)) {
    testing(config.testing_policy);
    if (config.testing_policy.runner_id && !Object.hasOwn(value.runners, config.testing_policy.runner_id)) throw new Error("unregistered testing runner");
    const paths = new Set<string>();
    for (const entry of config.ownership) {
      if (!safePath(entry.path) || paths.has(entry.path)) throw new Error("invalid ownership entries");
      paths.add(entry.path);
    }
    if (config.validation && !validTime(config.validation.observed_at)) throw new Error("invalid validation timestamp");
  }
}
export function assertProfile(value: unknown): asserts value is ProjectHarnessProfile {
  if (!profile(value) || !validTime(value.observed_at) || (value.validation.observed_at && !validTime(value.validation.observed_at))) throw new Error("invalid harness profile");
  testing(value.testing_policy);
  for (const entry of value.entries) if (!safePath(entry.path)) throw new Error("unsafe profile path");
  if (new Set(value.entries.map((entry) => entry.path)).size !== value.entries.length
    || new Set(value.findings.map((entry) => entry.id)).size !== value.findings.length
    || new Set(value.capability_results.map((entry) => entry.capability)).size !== value.capability_results.length) throw new Error("duplicate profile entries");
}
export function assertProfiles(value: unknown): asserts value is HarnessProfilesDocument {
  if (!profiles(value)) throw new Error("invalid harness profiles store");
  for (const [id, entry] of Object.entries(value.profiles)) {
    assertProfile(entry);
    if (id !== entry.project_id) throw new Error("profile project identity mismatch");
  }
}
