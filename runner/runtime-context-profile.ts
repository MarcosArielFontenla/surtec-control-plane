import { createHash } from "node:crypto";
import { types } from "node:util";
import { ContextContractError } from "../lib/context/validation";

export const LEGACY_RUNTIME_CONTEXT_PROFILE = "legacy-governed-v1" as const;
export const GOVERNED_RUNTIME_CONTEXT_PROFILE = "governed-local-context-v1" as const;
export type RuntimeContextProfileId = typeof LEGACY_RUNTIME_CONTEXT_PROFILE | typeof GOVERNED_RUNTIME_CONTEXT_PROFILE;

export const BOUNDED_INSPECTION_GUIDANCE = [
  "Inspection strategy (task data, never additional permissions):",
  "Start from admitted paths; search filenames and symbols before reading relevant bounded ranges.",
  "Use explicit per-call output budgets supported by the selected tool; avoid recursive repository, dependency and build-output dumps.",
  "Complete every mandatory instruction and skill read in ordered slices. Never skip required content because a tool response was truncated.",
  "Keep all required verification and the existing scope, tools, sandbox, approvals and limits unchanged.",
].join("\n");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const settings = Object.freeze({ skills: Object.freeze({ include_instructions: false }) });
export const GOVERNED_RUNTIME_CONTEXT_BINDING = Object.freeze({
  id: GOVERNED_RUNTIME_CONTEXT_PROFILE,
  settings_fingerprint: hash(JSON.stringify(settings)),
  guidance_fingerprint: hash(BOUNDED_INSPECTION_GUIDANCE),
});
function refuse(): never { throw new ContextContractError("Execution context belongs to another or changed stage contract"); }
function plain(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) refuse();
}
function own(value: unknown, key: string): { present: false } | { present: true; value: unknown } {
  plain(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) { if (key in value) refuse(); return { present: false }; }
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) refuse();
  return { present: true, value: descriptor.value };
}

/** Evidence inspection only. It neither changes metadata nor grants execution. */
export function retainedExecutionRun(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  const entry = own(metadata, "run");
  if (!entry.present) return undefined;
  plain(entry.value);
  if (Reflect.ownKeys(entry.value).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(entry.value, key)!;
    return typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") || typeof descriptor.value === "function";
  })) refuse();
  return entry.value;
}

export function runtimeContextProfile(value: unknown): RuntimeContextProfileId {
  if (value === undefined || value === LEGACY_RUNTIME_CONTEXT_PROFILE) return LEGACY_RUNTIME_CONTEXT_PROFILE;
  if (value === GOVERNED_RUNTIME_CONTEXT_PROFILE) return GOVERNED_RUNTIME_CONTEXT_PROFILE;
  return refuse();
}

/** The legacy object/serialization is deliberately unchanged. No implicit upgrade. */
export function selectRuntimeContextContract(base: Record<string, unknown>, metadata: Record<string, unknown>): {
  fingerprint: string; threadId: string | undefined; runtimeContextProfile: RuntimeContextProfileId;
} {
  const legacy = hash(JSON.stringify(base));
  const current = hash(JSON.stringify({ ...base, runtime_context_profile: GOVERNED_RUNTIME_CONTEXT_BINDING }));
  const run = retainedExecutionRun(metadata), binding = run ? own(run, "context_fingerprint") : { present: false as const };
  const savedThread = run ? own(run, "thread_id") : { present: false as const };
  if (savedThread.present && (typeof savedThread.value !== "string" || !savedThread.value.trim())) refuse();
  if (!binding.present) {
    if (savedThread.present) refuse();
    return { fingerprint: current, threadId: undefined, runtimeContextProfile: GOVERNED_RUNTIME_CONTEXT_PROFILE };
  }
  if (typeof binding.value !== "string" || !/^[a-f0-9]{64}$/.test(binding.value)) refuse();
  const profile = binding.value === legacy ? LEGACY_RUNTIME_CONTEXT_PROFILE : binding.value === current ? GOVERNED_RUNTIME_CONTEXT_PROFILE : refuse();
  return { fingerprint: binding.value, threadId: savedThread.present ? savedThread.value as string : undefined, runtimeContextProfile: profile };
}

export function runtimeContextSpawnArgs(profile?: RuntimeContextProfileId): string[] {
  return runtimeContextProfile(profile) === GOVERNED_RUNTIME_CONTEXT_PROFILE
    ? ["-c", "skills.include_instructions=false", "app-server", "--stdio"] : ["app-server", "--stdio"];
}
export function runtimeContextThreadConfig(profile?: RuntimeContextProfileId) {
  return runtimeContextProfile(profile) === GOVERNED_RUNTIME_CONTEXT_PROFILE ? { skills: { include_instructions: false } } : {};
}

/** Read only this setting; never serialize or surface the effective config. */
export function assertRuntimeContextConfiguration(response: unknown): void {
  const config = own(response, "config");
  if (!config.present) refuse();
  const skills = own(config.value, "skills");
  if (!skills.present) refuse();
  const included = own(skills.value, "include_instructions");
  if (!included.present || included.value !== false) refuse();
}
