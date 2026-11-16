import fs from "node:fs";
import * as fsBindings from "node:fs";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { types as nodeTypes } from "node:util";
import type { TaskRecord } from "../lib/state/types";

/** This diagnostic never accepts a project, state path, command or test filter. */
export const PROFILE_WORKLOADS = ["core", "routine-history", "stop-variants", "corrections", "recovery", "first-planner"] as const;
export type ProfileWorkload = typeof PROFILE_WORKLOADS[number];
export type ProfileSelection = ProfileWorkload | "first-planner-fs" | "first-planner-failure" | "first-planner-spans" | "full-suite-progress" | "full-suite-attribution" | "full-suite-workflow-timing";
export const PROFILE_LIMIT_MS = 900_000, PROFILE_CLEANUP_RESERVE_MS = 30_000, PROFILE_SAMPLES = 3;
const repository = resolve(dirname(fileURLToPath(import.meta.url)), ".."), script = fileURLToPath(import.meta.url);
const PREFIX = "surtec-maintenance-profile-", OUTPUT_LIMIT = 8 * 1024 * 1024;
const fsNames = ["lstatSync", "statSync", "openSync", "fstatSync", "readSync", "readFileSync", "writeFileSync", "appendFileSync", "mkdirSync", "fsyncSync", "renameSync", "unlinkSync", "closeSync", "existsSync", "readdirSync"] as const;
const objectNames = ["getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "getPrototypeOf"] as const;
type CoreKind = "boundary" | "tasks" | "events";
type ControlKind = "absent" | "null-hold";
type Phase = "preparation" | "action_verification" | "assertion_observation";
export interface Counts { [operation: string]: number }
interface CoreReceipt { preparation_ms: number; action_verification_ms: number; assertion_observation_ms: number; operations: number; counts: Record<Phase, Counts> | null; operation_elapsed_ms: Record<Phase, Counts> | null; observation_complete: boolean; writer_idle: true }
interface ChildResult { exit_code: number | null; closed: boolean; expired: boolean; failed: boolean; output: string; message: unknown; descendants_certain: boolean }
interface Sample { mode: "wall" | "counts" | "phases"; control: ControlKind | null; kind: CoreKind | "fixture"; sample: number; status: "passed" | "failed" | "deadline"; wall_ms: number; preparation_ms: number | null; action_verification_ms: number | null; assertion_observation_ms: number | null; fixture_test_ms: number | null; operations: number; counts: Record<Phase, Counts> | null; operation_elapsed_ms: Record<Phase, Counts> | null; planner_phases: PlannerPhaseReceipt | null; cleanup_ms: number; cleanup_complete: boolean }
export interface ProfileReport { schema_version: 1; workload: ProfileWorkload; status: "completed" | "failed" | "deadline"; wall_limit_ms: number; cleanup_reserve_ms: number; wall_ms: number; source_hashes: Record<string, string>; source_hashes_after: Record<string, string>; source_drift: boolean | null; samples: Sample[]; summaries: Array<{ kind: CoreKind | "fixture"; control: ControlKind | null; samples: number; median_wall_ms: number | null; maximum_wall_ms: number | null }>; cleanup: { complete: boolean; retained_owned_roots: number | null; uninspected_owned_roots: number | null; fixture_cleanup: "not-applicable" | "verified-no-new-prefix-roots" | "unavailable" }; limitations: string[] }

export const PLANNER_PHASES = ["issue-create", "issue-authorize", "preview", "admission", "dispatch", "terminal-observation", "assertions", "probe-reconcile", "probe-worker-tick", "probe-restart-reconcile", "probe-assertions", "cleanup"] as const;
export type PlannerPhase = typeof PLANNER_PHASES[number];
export interface PlannerPhaseReceipt { schema_version: 1; variant: "implementation"; phases_ms: Partial<Record<PlannerPhase, number>>; phase_counts: Partial<Record<PlannerPhase, number>>; observation_complete: boolean }
const PLANNER_MARKER = "PLANNER_PHASE_PROFILE ";
/** Infrastructure-owned timestamps only: never executes/awaits an action callback. */
export function createPlannerPhaseRecorder(clock: () => number = performance.now.bind(performance)): { begin(phase: PlannerPhase): () => void; receipt(): PlannerPhaseReceipt } {
  const phases_ms: Partial<Record<PlannerPhase, number>> = {}, phase_counts: Partial<Record<PlannerPhase, number>> = {}, active = new Set<PlannerPhase>();
  let failed = false, last: number | undefined, sealed: PlannerPhaseReceipt | undefined;
  const now = (): number | undefined => {
    try { const value = clock(); if (!finite(value) || last !== undefined && value < last) { failed = true; return; } last = value; return value; }
    catch { failed = true; return; }
  };
  return Object.freeze({
    begin(phase: PlannerPhase): () => void {
      if (sealed) { failed = true; return () => {}; }
      if (!(PLANNER_PHASES as readonly unknown[]).includes(phase) || Object.hasOwn(phase_counts, phase)) { failed = true; return () => {}; }
      if (phase === "cleanup" && active.size > 0 || active.has("cleanup")) failed = true;
      phase_counts[phase] = 1; active.add(phase); const started = now(); let ended = false;
      return () => {
        if (sealed) { failed = true; return; }
        if (ended) { failed = true; return; } ended = true; active.delete(phase); const stopped = now();
        if (started === undefined || stopped === undefined || stopped < started || stopped - started > PROFILE_LIMIT_MS) { failed = true; return; }
        phases_ms[phase] = stopped - started;
      };
    },
    receipt(): PlannerPhaseReceipt {
      if (!sealed) sealed = Object.freeze({ schema_version: 1, variant: "implementation", phases_ms: Object.freeze({ ...phases_ms }), phase_counts: Object.freeze({ ...phase_counts }), observation_complete: !failed && active.size === 0 && PLANNER_PHASES.every((phase) => phase_counts[phase] === 1 && Object.hasOwn(phases_ms, phase)) });
      else if (failed && sealed.observation_complete) sealed = Object.freeze({ ...sealed, observation_complete: false });
      return sealed;
    },
  });
}

export function sanitizePlannerPhaseReceipt(value: unknown): PlannerPhaseReceipt | null {
  try {
    const plain = (input: unknown): Record<string, unknown> | null => {
      if (!input || typeof input !== "object" || nodeTypes.isProxy(input) || Array.isArray(input) || ![null, Object.prototype].includes(Object.getPrototypeOf(input))) return null;
      const record: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(input)) { if (typeof key !== "string") return null; const property = Object.getOwnPropertyDescriptor(input, key)!; if (!Object.hasOwn(property, "value") || !property.enumerable) return null; Object.defineProperty(record, key, { value: property.value, enumerable: true }); }
      return record;
    };
    const record = plain(value); if (!record) return null;
    const data = record as unknown as PlannerPhaseReceipt;
    if (Object.keys(data).length !== 5 || Object.keys(data).some((key) => !["schema_version", "variant", "phases_ms", "phase_counts", "observation_complete"].includes(key)) || data.schema_version !== 1 || data.variant !== "implementation" || typeof data.observation_complete !== "boolean") return null;
    const phases_ms: Partial<Record<PlannerPhase, number>> = {}, phase_counts: Partial<Record<PlannerPhase, number>> = {};
    for (const [kind, table] of [["phases_ms", data.phases_ms], ["phase_counts", data.phase_counts]] as const) {
      const values = plain(table); if (!values) return null;
      for (const [key, number] of Object.entries(values)) {
        if (!(PLANNER_PHASES as readonly string[]).includes(key) || !finite(number) || number > PROFILE_LIMIT_MS || kind === "phase_counts" && number !== 1) return null;
        if (kind === "phases_ms") phases_ms[key as PlannerPhase] = number; else phase_counts[key as PlannerPhase] = number;
      }
    }
    if (Object.keys(phases_ms).some((key) => !Object.hasOwn(phase_counts, key))) return null;
    if (data.observation_complete && !PLANNER_PHASES.every((phase) => phase_counts[phase] === 1 && Object.hasOwn(phases_ms, phase))) return null;
    return { schema_version: 1, variant: "implementation", phases_ms, phase_counts, observation_complete: data.observation_complete };
  } catch { return null; }
}

export function parsePlannerPhaseOutput(output: string): PlannerPhaseReceipt | null {
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith(PLANNER_MARKER));
  if (lines.length !== 1) return null;
  try {
    const raw = lines[0]!.slice(PLANNER_MARKER.length), value: unknown = JSON.parse(raw), scopes: Array<Set<string>> = [];
    // JSON.parse otherwise silently collapses repeated properties, including escaped aliases.
    for (let index = 0; index < raw.length; index++) {
      if (raw[index] === "{") scopes.push(new Set()); else if (raw[index] === "}") scopes.pop();
      else if (raw[index] === '"') {
        const start = index++; for (; index < raw.length; index++) { if (raw[index] === "\\") index++; else if (raw[index] === '"') break; }
        let next = index + 1; while (/\s/.test(raw[next] ?? "") && next < raw.length) next++;
        if (raw[next] === ":") { const key = JSON.parse(raw.slice(start, index + 1)) as string, scope = scopes.at(-1); if (!scope || scope.has(key)) return null; scope.add(key); }
      }
    }
    return sanitizePlannerPhaseReceipt(value);
  }
  catch { return null; }
}

export function parseProfileArguments(args: readonly string[]): ProfileSelection {
  if (args.length === 0) return "core";
  if (args.length === 1 && args[0]?.startsWith("--workload=")) {
    const value = args[0].slice("--workload=".length);
    if ((PROFILE_WORKLOADS as readonly string[]).includes(value)) return value as ProfileWorkload;
    if (value === "first-planner-fs") return value;
    if (value === "first-planner-failure") return value;
    if (value === "first-planner-spans") return value;
    if (value === "full-suite-progress") return value;
    if (value === "full-suite-attribution") return value;
    if (value === "full-suite-workflow-timing") return value;
  }
  throw new Error("Only one fixed --workload selection is accepted.");
}

export const PLANNER_FS_PHASES = ["admission", "dispatch"] as const;
export type PlannerFsPhase = typeof PLANNER_FS_PHASES[number];
export interface PlannerFsReceipt {
  schema_version: 1; variant: "implementation"; phases_wall_ms: Partial<Record<PlannerFsPhase, number>>; phase_counts: Partial<Record<PlannerFsPhase, number>>;
  counts: Partial<Record<PlannerFsPhase, Counts>>; operation_elapsed_ms: Partial<Record<PlannerFsPhase, Counts>>; observation_complete: boolean; restoration_complete: boolean;
}
const PLANNER_FS_MARKER = "PLANNER_FS_PROFILE ";
interface PlannerFsObservationDependencies { target?: object; clock?: () => number; synchronize?: () => void }
/** Fixed diagnostic observer; dependencies substitute infrastructure only in tiny unit fixtures. */
export function createPlannerFsObserver(dependencies: PlannerFsObservationDependencies = {}): { begin(phase: PlannerFsPhase): () => void; finish(): void; receipt(): PlannerFsReceipt } {
  const target = dependencies.target ?? fs, sourceClock = dependencies.clock ?? performance.now.bind(performance), synchronize = dependencies.synchronize ?? syncBuiltinESMExports;
  const counts: Partial<Record<PlannerFsPhase, Counts>> = {}, operation_elapsed_ms: Partial<Record<PlannerFsPhase, Counts>> = {}, phases_wall_ms: Partial<Record<PlannerFsPhase, number>> = {}, phase_counts: Partial<Record<PlannerFsPhase, number>> = {};
  interface OwnedPatch { name: string; original: PropertyDescriptor; wrapper: (...args: unknown[]) => unknown; installed: boolean }
  interface Window { phase: PlannerFsPhase; start: number | undefined; patches: OwnedPatch[]; ended: boolean }
  let failed = false, restorationFault = false, finished = false, last: number | undefined, active: Window | undefined, sealed: PlannerFsReceipt | undefined;
  const now = (): number | undefined => { try { const value = sourceClock(); if (!finite(value) || last !== undefined && value < last) { failed = true; return; } last = value; return value; } catch { failed = true; return; } };
  const restore = (window: Window) => {
    for (const patch of [...window.patches].reverse()) try {
      const current = Object.getOwnPropertyDescriptor(target, patch.name);
      if (current && current.value === patch.original.value && current.configurable === patch.original.configurable && current.enumerable === patch.original.enumerable && current.writable === patch.original.writable) { if (patch.installed) failed = true; continue; }
      if (!current || current.value !== patch.wrapper || current.configurable !== patch.original.configurable || current.enumerable !== patch.original.enumerable || current.writable !== patch.original.writable) { failed = restorationFault = true; continue; }
      Object.defineProperty(target, patch.name, patch.original);
    } catch { failed = restorationFault = true; }
    window.patches = [];
    try { synchronize(); if (target === fs && fsNames.some((name) => (fsBindings as unknown as Record<string, unknown>)[name] !== Object.getOwnPropertyDescriptor(target, name)?.value)) failed = restorationFault = true; } catch { failed = restorationFault = true; }
  };
  const close = (window: Window, incomplete = false) => {
    if (sealed || window.ended || active !== window) { failed = true; return; }
    if (incomplete) failed = true; window.ended = true; active = undefined; restore(window);
    const ended = now(); if (!incomplete && window.start !== undefined && ended !== undefined && ended >= window.start && ended - window.start <= PROFILE_LIMIT_MS) phases_wall_ms[window.phase] = ended - window.start; else failed = true;
  };
  const observer = {
    begin(phase: PlannerFsPhase): () => void {
      if (sealed || finished || active || !(PLANNER_FS_PHASES as readonly unknown[]).includes(phase) || Object.hasOwn(phase_counts, phase)) { failed = true; return () => {}; }
      phase_counts[phase] = 1; counts[phase] = {}; operation_elapsed_ms[phase] = {};
      const window: Window = { phase, start: now(), patches: [], ended: false }; active = window;
      try {
        if (!target || nodeTypes.isProxy(target)) throw new Error();
        for (const name of fsNames) {
          const original = Object.getOwnPropertyDescriptor(target, name); if (!original || !Object.hasOwn(original, "value") || typeof original.value !== "function" || !original.configurable) throw new Error();
          const operation = original.value as (...args: unknown[]) => unknown;
          const wrapper = function (this: unknown, ...args: unknown[]): unknown {
            if (active !== window || window.ended || finished || sealed) { failed = true; return Reflect.apply(operation, this, args); }
            const key = `fs.${name}`; let started: number | undefined;
            try { const next = (counts[phase]![key] ?? 0) + 1; if (!Number.isSafeInteger(next)) failed = true; else counts[phase]![key] = next; started = now(); } catch { failed = true; }
            try { return Reflect.apply(operation, this, args); }
            finally {
              if (active !== window || window.ended || finished || sealed) failed = true;
              else try { const ended = now(); if (started === undefined || ended === undefined || ended < started) failed = true;
                else { const sum = (operation_elapsed_ms[phase]![key] ?? 0) + ended - started; if (!finite(sum) || sum > PROFILE_LIMIT_MS) failed = true; else operation_elapsed_ms[phase]![key] = sum; }
              } catch { failed = true; }
            }
          };
          const patch: OwnedPatch = { name, original, wrapper, installed: false }; window.patches.push(patch); Object.defineProperty(target, name, { ...original, value: wrapper });
          if (Object.getOwnPropertyDescriptor(target, name)?.value !== wrapper) throw new Error();
          patch.installed = true;
        }
        try { synchronize(); if (target === fs && fsNames.some((name) => (fsBindings as unknown as Record<string, unknown>)[name] !== Object.getOwnPropertyDescriptor(target, name)?.value)) failed = true; } catch { failed = true; }
      } catch { failed = true; restore(window); }
      return () => { try { close(window); } catch { failed = restorationFault = true; } };
    },
    finish(): void { try { if (sealed || finished) { failed = true; return; } if (active) close(active, true); finished = true; } catch { failed = restorationFault = true; finished = true; } },
    receipt(): PlannerFsReceipt {
      if (!finished) { failed = true; observer.finish(); }
      if (!sealed) {
        const complete = !failed && !restorationFault && !active && PLANNER_FS_PHASES.every((phase) => phase_counts[phase] === 1 && Object.hasOwn(phases_wall_ms, phase) && fsOperationPair(counts[phase], operation_elapsed_ms[phase]));
        sealed = Object.freeze({ schema_version: 1, variant: "implementation", phases_wall_ms: Object.freeze({ ...phases_wall_ms }), phase_counts: Object.freeze({ ...phase_counts }), counts: Object.freeze(Object.fromEntries(Object.entries(counts).map(([phase, table]) => [phase, Object.freeze({ ...table })]))), operation_elapsed_ms: Object.freeze(Object.fromEntries(Object.entries(operation_elapsed_ms).map(([phase, table]) => [phase, Object.freeze({ ...table })]))), observation_complete: complete, restoration_complete: !restorationFault && !active });
      } else if (failed && sealed.observation_complete || restorationFault && sealed.restoration_complete) sealed = Object.freeze({ ...sealed, observation_complete: false, restoration_complete: !restorationFault && !active });
      return sealed;
    },
  };
  return Object.freeze(observer);
}
function fsOperationPair(counts: unknown, elapsed: unknown): boolean {
  if (!counts || !elapsed || typeof counts !== "object" || typeof elapsed !== "object") return false;
  const a = counts as Counts, b = elapsed as Counts, keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every((key) => a[key]! > 0 && Object.hasOwn(b, key));
}
function plainAggregate(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return null;
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) { if (typeof key !== "string") return null; const descriptor = Object.getOwnPropertyDescriptor(value, key)!; if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return null; Object.defineProperty(result, key, { value: descriptor.value, enumerable: true }); }
  return result;
}
export function sanitizePlannerFsReceipt(value: unknown): PlannerFsReceipt | null {
  try {
    const data = plainAggregate(value); if (!data || Object.keys(data).length !== 8 || Object.keys(data).some((key) => !["schema_version", "variant", "phases_wall_ms", "phase_counts", "counts", "operation_elapsed_ms", "observation_complete", "restoration_complete"].includes(key)) || data.schema_version !== 1 || data.variant !== "implementation" || typeof data.observation_complete !== "boolean" || typeof data.restoration_complete !== "boolean") return null;
    const wall: PlannerFsReceipt["phases_wall_ms"] = {}, repetitions: PlannerFsReceipt["phase_counts"] = {}, counts: PlannerFsReceipt["counts"] = {}, elapsed: PlannerFsReceipt["operation_elapsed_ms"] = {};
    for (const field of ["phases_wall_ms", "phase_counts", "counts", "operation_elapsed_ms"] as const) {
      const table = plainAggregate(data[field]); if (!table) return null;
      for (const [phase, input] of Object.entries(table)) {
        if (!(PLANNER_FS_PHASES as readonly string[]).includes(phase)) return null; const key = phase as PlannerFsPhase;
        if (field === "phases_wall_ms" || field === "phase_counts") { if (!finite(input) || input > PROFILE_LIMIT_MS || field === "phase_counts" && input !== 1) return null; if (field === "phase_counts") repetitions[key] = input; else wall[key] = input; }
        else {
          const operations = plainAggregate(input); if (!operations) return null; const values: Counts = {};
          for (const [operation, number] of Object.entries(operations)) { if (!(fsNames as readonly string[]).some((name) => operation === `fs.${name}`) || !finite(number) || field === "counts" && (!Number.isSafeInteger(number) || number === 0) || field === "operation_elapsed_ms" && number > PROFILE_LIMIT_MS) return null; values[operation] = number; }
          if (field === "counts") counts[key] = values; else elapsed[key] = values;
        }
      }
    }
    for (const table of [wall, counts, elapsed]) if (Object.keys(table).some((phase) => !Object.hasOwn(repetitions, phase))) return null;
    if (data.observation_complete && (!data.restoration_complete || !PLANNER_FS_PHASES.every((phase) => repetitions[phase] === 1 && Object.hasOwn(wall, phase) && fsOperationPair(counts[phase], elapsed[phase])))) return null;
    return { schema_version: 1, variant: "implementation", phases_wall_ms: wall, phase_counts: repetitions, counts, operation_elapsed_ms: elapsed, observation_complete: data.observation_complete, restoration_complete: data.restoration_complete };
  } catch { return null; }
}
function parseFsReceiptLine(line: string): PlannerFsReceipt | null {
  try {
    const raw = line.slice(PLANNER_FS_MARKER.length), value: unknown = JSON.parse(raw), scopes: Array<Set<string>> = [];
    for (let index = 0; index < raw.length; index++) {
      if (raw[index] === "{") scopes.push(new Set()); else if (raw[index] === "}") scopes.pop();
      else if (raw[index] === '"') { const start = index++; for (; index < raw.length; index++) { if (raw[index] === "\\") index++; else if (raw[index] === '"') break; }
        let next = index + 1; while (next < raw.length && /\s/.test(raw[next]!)) next++;
        if (raw[next] === ":") { const key = JSON.parse(raw.slice(start, index + 1)) as string, scope = scopes.at(-1); if (!scope || scope.has(key)) return null; scope.add(key); }
      }
    }
    return sanitizePlannerFsReceipt(value);
  } catch { return null; }
}
/** Bounded streaming receipt projection; raw stdout is never forwarded to progress. */
export function createPlannerFsMarkerCollector(progress: (receipt: PlannerFsReceipt | null) => void = () => {}): { push(chunk: string): void; finish(): PlannerFsReceipt | null } {
  let line = "", discard = false, markers = 0, invalid = false, receipt: PlannerFsReceipt | null = null;
  const emit = () => { if (line.startsWith(PLANNER_FS_MARKER)) { markers++; receipt = markers === 1 ? parseFsReceiptLine(line.replace(/\r$/, "")) : null; if (!receipt) invalid = true; try { progress(invalid ? null : receipt); } catch { invalid = true; } } line = ""; discard = false; };
  return {
    push(chunk: string): void { for (const char of chunk) { if (char === "\n") emit(); else if (!discard) { line += char;
      if (markers > 0 && !invalid && line.startsWith(PLANNER_FS_MARKER)) { invalid = true; try { progress(null); } catch { /* Aggregate remains unavailable. */ } }
      if (line.length > 128 * 1024) { if (line.startsWith(PLANNER_FS_MARKER)) { invalid = true; try { progress(null); } catch { /* Aggregate remains unavailable. */ } } line = ""; discard = true; } } } },
    finish(): PlannerFsReceipt | null { if (line.startsWith(PLANNER_FS_MARKER)) invalid = true; return markers === 1 && !invalid ? receipt : null; },
  };
}
export function parsePlannerFsOutput(output: string): PlannerFsReceipt | null { const collector = createPlannerFsMarkerCollector(); collector.push(output); return collector.finish(); }

export interface PlannerFsDiagnosticReport {
  schema_version: 1; workload: "first-planner-fs"; diagnostic_only: true; acceptance: false; status: "completed" | "failed" | "deadline"; wall_ms: number;
  wall_limit_ms: number; cleanup_reserve_ms: number; source_hashes: Record<string, string>; source_hashes_after: Record<string, string>; source_drift: boolean | null;
  receipt: PlannerFsReceipt | null; suite: { passed: boolean; passed_tests: number; failed_tests: number; skipped_tests: number; test_ms: number } | null;
  first_planner: { passed: boolean; test_ms: number } | null; cleanup: "verified-normal-suite-and-no-new-planner-prefix-roots" | "unavailable-no-uncertain-fixture-deleted"; limitations: string[];
}
const fsDiagnosticSources = ["scripts/profile-maintenance.ts", "lib/state/maintenance.ts", "lib/state/store.ts", "lib/state/events.ts", "lib/state/paths.ts", "lib/state/validation.ts", "schemas/maintenance-control.schema.json", "runner/workflow-orchestrator.test.ts"];
const fsDiagnosticLimitations = ["One original full Vitest workload, original worker configuration and limits; only the first implementation Planner admission/dispatch windows are instrumented.", "Windows include same-worker callbacks, heartbeats and microtasks; selected public exports are not all I/O, previously captured aliases or a kernel census.", "Phase wall includes installation/restoration overhead; export durations are synchronous inclusive observations with observer overhead and possible overlap, not disjoint kernel or CPU attribution.", "A partial or complete receipt never proves test, suite, source or cleanup acceptance; expired and uncertain writers remain unavailable."];
export function plannerFsEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv { return { ...profileEnvironment(source), SURTEC_TEST_PLANNER_FS_PROFILE: "1" }; }
export function summarizeLoadedVitestOutput(output: string): { suite: PlannerFsDiagnosticReport["suite"]; first_planner: PlannerFsDiagnosticReport["first_planner"] } {
  try {
    const start = output.search(/\{\s*"numTotalTestSuites"\s*:/); if (start < 0) throw new Error();
    const data = JSON.parse(output.slice(start)) as { success?: unknown; testResults?: unknown }; if (!Array.isArray(data.testResults)) throw new Error();
    let passed_tests = 0, failed_tests = 0, skipped_tests = 0, test_ms = 0, first_planner: PlannerFsDiagnosticReport["first_planner"] = null, planners = 0, invalid = false;
    for (const module of data.testResults) {
      if (!module || typeof module !== "object" || !Array.isArray(module.assertionResults)) throw new Error();
      for (const test of module.assertionResults) {
        if (!test || typeof test !== "object") throw new Error();
        if (["pending", "skipped", "todo"].includes(test.status)) { skipped_tests++; continue; }
        if (test.status === "passed") passed_tests++; else if (test.status === "failed") failed_tests++; else invalid = true;
        if (finite(test.duration)) test_ms += test.duration; else invalid = true;
        if (typeof module.name === "string" && module.name.replace(/\\/g, "/").endsWith("runner/workflow-orchestrator.test.ts") && typeof test.fullName === "string" && test.fullName.endsWith(fixtures["first-planner"].pattern)) { planners++; if (finite(test.duration)) first_planner = { passed: test.status === "passed", test_ms: test.duration }; }
      }
    }
    if (planners !== 1) first_planner = null;
    return { suite: { passed: data.success === true && failed_tests === 0 && !invalid && passed_tests > 0, passed_tests, failed_tests, skipped_tests, test_ms }, first_planner };
  } catch { return { suite: null, first_planner: null }; }
}
function fsUnavailableReport(deadline: ProfileDeadline, expired = false, receipt: PlannerFsReceipt | null = null): PlannerFsDiagnosticReport {
  return { schema_version: 1, workload: "first-planner-fs", diagnostic_only: true, acceptance: false, status: expired ? "deadline" : "failed", wall_ms: deadline.elapsed(), wall_limit_ms: PROFILE_LIMIT_MS, cleanup_reserve_ms: PROFILE_CLEANUP_RESERVE_MS, source_hashes: {}, source_hashes_after: {}, source_drift: null, receipt, suite: null, first_planner: null, cleanup: "unavailable-no-uncertain-fixture-deleted", limitations: [...fsDiagnosticLimitations] };
}
export function sanitizePlannerFsDiagnostic(value: unknown): PlannerFsDiagnosticReport | null {
  try {
    const data = plainAggregate(value); if (!data || data.schema_version !== 1 || data.workload !== "first-planner-fs" || data.diagnostic_only !== true || data.acceptance !== false || !["completed", "failed", "deadline"].includes(data.status as string) || !finite(data.wall_ms) || ![true, false, null].includes(data.source_drift as boolean | null)) return null;
    const hashes = (value: unknown): Record<string, string> | null => { const fields = plainAggregate(value); if (!fields) return null; const result: Record<string, string> = {}; for (const [key, value] of Object.entries(fields)) { if (!fsDiagnosticSources.includes(key) || typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return null; result[key] = value; } return result; };
    const source_hashes = hashes(data.source_hashes), source_hashes_after = hashes(data.source_hashes_after), receipt = data.receipt === null ? null : sanitizePlannerFsReceipt(data.receipt);
    if (!source_hashes || !source_hashes_after || data.receipt !== null && !receipt || !["verified-normal-suite-and-no-new-planner-prefix-roots", "unavailable-no-uncertain-fixture-deleted"].includes(data.cleanup as string)) return null;
    let suite: PlannerFsDiagnosticReport["suite"] = null, first_planner: PlannerFsDiagnosticReport["first_planner"] = null;
    if (data.suite !== null) { const result = plainAggregate(data.suite); if (!result || typeof result.passed !== "boolean" || !finite(result.test_ms)) return null; for (const key of ["passed_tests", "failed_tests", "skipped_tests"]) if (!finite(result[key]) || !Number.isSafeInteger(result[key])) return null; suite = { passed: result.passed, test_ms: result.test_ms, passed_tests: result.passed_tests as number, failed_tests: result.failed_tests as number, skipped_tests: result.skipped_tests as number }; }
    if (data.first_planner !== null) { const result = plainAggregate(data.first_planner); if (!result || typeof result.passed !== "boolean" || !finite(result.test_ms)) return null; first_planner = { passed: result.passed, test_ms: result.test_ms }; }
    if (suite?.passed && (suite.failed_tests > 0 || suite.passed_tests === 0) || first_planner?.passed && (!suite || suite.passed_tests === 0)) return null;
    if (data.source_drift !== null && data.source_drift !== sourceHashesChanged(source_hashes, source_hashes_after)) return null;
    if (data.status === "completed" && (data.wall_ms > PROFILE_LIMIT_MS || !receipt?.observation_complete || !receipt.restoration_complete || !suite?.passed || suite.passed_tests === 0 || suite.failed_tests !== 0 || !first_planner?.passed || data.source_drift !== false || Object.keys(source_hashes).length !== fsDiagnosticSources.length || data.cleanup !== "verified-normal-suite-and-no-new-planner-prefix-roots")) return null;
    return { schema_version: 1, workload: "first-planner-fs", diagnostic_only: true, acceptance: false, status: data.status as PlannerFsDiagnosticReport["status"], wall_ms: data.wall_ms, wall_limit_ms: PROFILE_LIMIT_MS, cleanup_reserve_ms: PROFILE_CLEANUP_RESERVE_MS, source_hashes, source_hashes_after, source_drift: data.source_drift as boolean | null, receipt, suite, first_planner, cleanup: data.cleanup as PlannerFsDiagnosticReport["cleanup"], limitations: [...fsDiagnosticLimitations] };
  } catch { return null; }
}
export function plannerFsArguments(): string[] { return [join(repository, "node_modules/vitest/vitest.mjs"), "run", "--reporter=json"]; }
async function runLoadedPlannerFs(deadline: ProfileDeadline, progress: (report: PlannerFsDiagnosticReport) => void): Promise<PlannerFsDiagnosticReport> {
  const report = fsUnavailableReport(deadline); let output = "", outputBytes = 0, oversized = false;
  try {
    report.source_hashes = sourceHashes(fsDiagnosticSources); const before = prefixInventory("surtec-workflow-worker-");
    if (!deadline.mayLaunch()) { report.status = "deadline"; return report; }
    const collector = createPlannerFsMarkerCollector((receipt) => { report.receipt = receipt; progress({ ...report, wall_ms: deadline.elapsed() }); });
    const child = spawn(process.execPath, plannerFsArguments(), { cwd: repository, env: plannerFsEnvironment(process.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const pending = superviseChild(child, deadline);
    child.stdout?.on("data", (chunk: Buffer) => { const text = chunk.toString(); outputBytes += chunk.length; if (outputBytes <= OUTPUT_LIMIT) output += text; else oversized = true; collector.push(text); }); child.stderr?.on("data", () => {});
    const outcome = await pending; report.receipt = collector.finish(); const aggregate = summarizeLoadedVitestOutput(output); report.suite = aggregate.suite; report.first_planner = aggregate.first_planner;
    report.status = outcome.expired ? "deadline" : "failed";
    const normal = outcome.closed && !outcome.expired && !outcome.failed && !oversized && outcome.exit_code === 0;
    if (normal && aggregate.suite?.passed && [...prefixInventory("surtec-workflow-worker-")].every((name) => before.has(name))) report.cleanup = "verified-normal-suite-and-no-new-planner-prefix-roots";
    if (deadline.remaining() > 0) { report.source_hashes_after = sourceHashes(fsDiagnosticSources); report.source_drift = sourceHashesChanged(report.source_hashes, report.source_hashes_after); }
    if (normal && report.receipt?.observation_complete && report.receipt.restoration_complete && report.suite?.passed && report.first_planner?.passed && report.source_drift === false && report.cleanup === "verified-normal-suite-and-no-new-planner-prefix-roots") report.status = "completed";
  } catch { report.status = deadline.remaining() <= 0 ? "deadline" : "failed"; }
  report.wall_ms = deadline.elapsed(); if (deadline.remaining() <= 0) { report.status = "deadline"; report.cleanup = "unavailable-no-uncertain-fixture-deleted"; } return report;
}
interface FsControllerChild extends SupervisedChild { on(event: "message", listener: (value: unknown) => void): unknown; send(message: { role: "planner-fs-controller"; origin_ms: number }): unknown }
export async function runPlannerFsDiagnosticWatchdog(deadline = new ProfileDeadline(), launch: () => FsControllerChild = () => fork(script, [], { cwd: repository, execArgv: ["--import", "tsx"], env: profileEnvironment(process.env), stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true })): Promise<PlannerFsDiagnosticReport> {
  if (!deadline.mayLaunch()) return fsUnavailableReport(deadline, true);
  let finalReceipt: unknown, partialReceipt: unknown;
  try {
    const controller = launch(), cancellation = new AbortController(), pending = superviseChild(controller, deadline, 1000, cancellation.signal, "cleanup");
    controller.stdout?.on?.("data", () => {}); controller.stderr?.on?.("data", () => {});
    controller.on("message", (value) => { const data = plainAggregate(value); if (data?.role === "planner-fs-report") finalReceipt = data.report; else if (data?.role === "planner-fs-progress") partialReceipt = data.report; });
    try { controller.send({ role: "planner-fs-controller", origin_ms: performance.timeOrigin }); } catch { cancellation.abort(); }
    const outcome = await pending, report = sanitizePlannerFsDiagnostic(finalReceipt), partial = sanitizePlannerFsDiagnostic(partialReceipt);
    if (!outcome.closed || outcome.expired || outcome.failed || outcome.exit_code !== 0 || !report || deadline.remaining() <= 0) { const unavailable = fsUnavailableReport(deadline, outcome.expired || deadline.remaining() <= 0, partial?.receipt ?? null); unavailable.source_hashes = partial?.source_hashes ?? {}; return unavailable; }
    report.wall_ms = deadline.elapsed(); return report;
  } catch { return fsUnavailableReport(deadline, deadline.remaining() <= 0, sanitizePlannerFsDiagnostic(partialReceipt)?.receipt ?? null); }
}
async function plannerFsControllerWorker(value: unknown): Promise<void> {
  try {
    const data = plainAggregate(value); if (!data || !finite(data.origin_ms)) throw new Error(); const origin = data.origin_ms;
    const deadline = new ProfileDeadline(() => performance.timeOrigin + performance.now() - origin);
    const report = await runLoadedPlannerFs(deadline, (partial) => { if (!process.send || !process.connected) throw new Error(); process.send({ role: "planner-fs-progress", report: partial }, () => {}); });
    if (!process.send) throw new Error(); process.send({ role: "planner-fs-report", report }, (error) => { if (process.connected) process.disconnect(); process.exitCode = error ? 1 : 0; });
  } catch { if (process.connected) process.disconnect(); process.exitCode = 1; }
}

export const PLANNER_FAILURE_CASE = "runs only the exact first read-only implementation stage and retains a human gate";
export const PLANNER_TEST_TIMEOUT_MESSAGE = 'Test timed out in 5000ms.\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".';
export const PLANNER_HOOK_TIMEOUT_MESSAGE = 'Hook timed out in 10000ms.\nIf this is a long-running hook, pass a timeout value as the last argument or configure it globally with "hookTimeout".';
const PLANNER_FAILURE_MARKER = "PLANNER_FAILURE_PROFILE ", PLANNER_FAILURE_LINE_BYTES = 8192;
const failureFixturePath = join(repository, "runner/workflow-orchestrator.test.ts").replace(/\\/g, "/");
const failureNames = ["Error", "AssertionError", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "AggregateError", "unknown"] as const;
const failureReasons = ["invalid-context", "source-limits-unavailable", "invalid-result", "invalid-errors", "invalid-counters"] as const;
export interface PlannerFailureSourceLimits { line_columns: readonly number[] }
const preparedFailureLimits = new WeakSet<object>();
export interface PlannerFailureReceipt {
  schema_version: 1; kind: "planner-failure-observation"; variant: "implementation"; observation_point: "start-of-existing-root-afterEach"; result_scope: "pre-cleanup-framework-result"; acceptance: false;
  framework_state: "pass" | "fail" | "unavailable"; error_count: number | null;
  errors: Array<{ index: number; reported_name: typeof failureNames[number]; signature: "test-timeout-5000" | "hook-timeout-10000" | "unsupported"; message: string | null; sites: Array<{ source: "workflow-fixture"; line: number; column: number }>; positions_status: "available" | "unavailable" | "limit-reached" }>;
  capture_status: "captured" | "unavailable"; classification_complete: boolean; unavailable_reason: typeof failureReasons[number] | null;
}
/** Read only a named own data descriptor; framework context may be a function. */
function failureOwn(value: unknown, key: string, context = false): { present: boolean; value: unknown } {
  if (!value || !(typeof value === "object" || context && typeof value === "function") || nodeTypes.isProxy(value)) throw new Error();
  if (!context && !Array.isArray(value) && ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new Error();
  const property = Object.getOwnPropertyDescriptor(value, key); if (!property) return { present: false, value: undefined };
  if (!Object.hasOwn(property, "value")) throw new Error(); return { present: true, value: property.value };
}
function failureString(value: unknown, limit: number): value is string { return typeof value === "string" && value.length <= limit && Buffer.byteLength(value, "utf8") <= limit; }
function failurePayload(value: unknown): boolean { return Boolean(value && typeof value === "object" && !nodeTypes.isProxy(value) && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value))); }
function failureLimits(value: unknown): PlannerFailureSourceLimits | null {
  try {
    if (value && typeof value === "object" && preparedFailureLimits.has(value)) return value as PlannerFailureSourceLimits;
    const input = failureOwn(value, "line_columns").value; if (!Array.isArray(input) || nodeTypes.isProxy(input)) return null;
    const length = failureOwn(input, "length").value; if (!Number.isSafeInteger(length) || (length as number) < 1 || (length as number) > 10_000) return null;
    const line_columns: number[] = []; for (let index = 0; index < (length as number); index++) { const column = failureOwn(input, String(index)); if (!column.present || !Number.isSafeInteger(column.value) || (column.value as number) < 1 || (column.value as number) > 65536) return null; line_columns.push(column.value as number); }
    if (Buffer.byteLength(JSON.stringify({ line_columns }), "utf8") > 128 * 1024) return null;
    const limits = Object.freeze({ line_columns: Object.freeze(line_columns) }); preparedFailureLimits.add(limits); return limits;
  } catch { return null; }
}
function preparePlannerFailureSourceLimits(): PlannerFailureSourceLimits | null {
  return preparePlannerFailureSourceMetadata()?.sourceLimits ?? null;
}
function unavailableFailure(reason: typeof failureReasons[number]): PlannerFailureReceipt {
  return Object.freeze({ schema_version: 1, kind: "planner-failure-observation", variant: "implementation", observation_point: "start-of-existing-root-afterEach", result_scope: "pre-cleanup-framework-result", acceptance: false, framework_state: "unavailable", error_count: null, errors: Object.freeze([]) as unknown as PlannerFailureReceipt["errors"], capture_status: "unavailable", classification_complete: false, unavailable_reason: reason });
}
/** Detached projection only: no getters, arbitrary formatting, recursive data or domain reads. */
export function projectPlannerFailureContext(context: unknown, sourceLimits: PlannerFailureSourceLimits | null): PlannerFailureReceipt | null {
  let task: unknown, result: unknown;
  try {
    task = failureOwn(context, "task", true).value; if (!failurePayload(task)) return null;
    const name = failureOwn(task, "name").value, file = failureOwn(task, "file").value; if (!failurePayload(file)) return null;
    const filepath = failureOwn(file, "filepath").value;
    if (name !== PLANNER_FAILURE_CASE || !failureString(filepath, 1024) || filepath.replace(/\\/g, "/") !== failureFixturePath) return null;
  } catch { return null; }
  const limits = failureLimits(sourceLimits); if (!limits) return unavailableFailure("source-limits-unavailable");
  let state: unknown, errors: unknown;
  try { result = failureOwn(task, "result").value; if (!failurePayload(result)) return unavailableFailure("invalid-result"); state = failureOwn(result, "state").value; if (state !== "pass" && state !== "fail") return unavailableFailure("invalid-result"); }
  catch { return unavailableFailure("invalid-result"); }
  try { if (failureOwn(result, "retryCount").value !== 0 || failureOwn(result, "repeatCount").value !== 0) return unavailableFailure("invalid-counters"); }
  catch { return unavailableFailure("invalid-counters"); }
  try { errors = failureOwn(result, "errors").value; } catch { return unavailableFailure("invalid-errors"); }
  try {
    const count = errors === undefined && state === "pass" ? 0 : Array.isArray(errors) && !nodeTypes.isProxy(errors) ? failureOwn(errors, "length").value : null;
    if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 8 || state === "fail" && count === 0 || state === "pass" && count !== 0) return unavailableFailure("invalid-errors");
    if (errors !== undefined && Reflect.ownKeys(errors as object).length !== (count as number) + 1) return unavailableFailure("invalid-errors");
    const projected: PlannerFailureReceipt["errors"] = []; let sitesRemaining = 3;
    const escaped = failureFixturePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), sitePattern = new RegExp(`(?:^|[ (])${escaped}:(\\d{1,5}):(\\d{1,5})(?:\\)|\\s*)$`);
    for (let index = 0; index < (count as number); index++) {
      const entry = failureOwn(errors, String(index)); if (!entry.present || !failurePayload(entry.value)) return unavailableFailure("invalid-errors");
      const rawName = failureOwn(entry.value, "name").value, message = failureOwn(entry.value, "message").value, stack = failureOwn(entry.value, "stack").value;
      const reported_name = (failureNames as readonly unknown[]).includes(rawName) ? rawName as typeof failureNames[number] : "unknown";
      const signature = failureString(message, 1024) && message === PLANNER_TEST_TIMEOUT_MESSAGE ? "test-timeout-5000" : failureString(message, 1024) && message === PLANNER_HOOK_TIMEOUT_MESSAGE ? "hook-timeout-10000" : "unsupported";
      const sites: PlannerFailureReceipt["errors"][number]["sites"] = []; let positions_status: PlannerFailureReceipt["errors"][number]["positions_status"] = "unavailable";
      if (failureString(stack, 65536)) {
        positions_status = "available"; const lines = stack.split(/\r?\n/, 129);
        if (lines.length >= 128) positions_status = "limit-reached";
        for (const line of lines.slice(0, 128)) {
          const match = sitePattern.exec(line.replace(/\\/g, "/")); if (!match) continue;
          const sourceLine = Number(match[1]), column = Number(match[2]);
          if (sourceLine < 1 || sourceLine > limits.line_columns.length || column < 1 || column > limits.line_columns[sourceLine - 1]!) continue;
          if (sitesRemaining === 0) { positions_status = "limit-reached"; continue; }
          sites.push(Object.freeze({ source: "workflow-fixture", line: sourceLine, column })); sitesRemaining--;
          if (sitesRemaining === 0) positions_status = "limit-reached";
        }
      }
      projected.push(Object.freeze({ index, reported_name, signature, message: signature === "test-timeout-5000" ? "Test timed out in 5000ms." : signature === "hook-timeout-10000" ? "Hook timed out in 10000ms." : null, sites: Object.freeze(sites) as unknown as typeof sites, positions_status }));
    }
    return Object.freeze({ schema_version: 1, kind: "planner-failure-observation", variant: "implementation", observation_point: "start-of-existing-root-afterEach", result_scope: "pre-cleanup-framework-result", acceptance: false, framework_state: state, error_count: count as number, errors: Object.freeze(projected) as unknown as typeof projected, capture_status: "captured", classification_complete: projected.every((entry) => entry.signature !== "unsupported"), unavailable_reason: null });
  } catch { return unavailableFailure("invalid-errors"); }
}
interface PlannerFailureCaptureDependencies { env?: NodeJS.ProcessEnv; write?: (line: string) => unknown; sourceLimits?: PlannerFailureSourceLimits | null }
/** Metadata preparation happens outside the hook. Emission is one best-effort native write. */
export function createPlannerFailureCapture(dependencies: PlannerFailureCaptureDependencies = {}): { capture(context: unknown): void } {
  let enabled = false, limits: PlannerFailureSourceLimits | null = null;
  try {
    const env = dependencies.env ?? process.env;
    if (!env || typeof env !== "object" || nodeTypes.isProxy(env)) throw new Error();
    enabled = failureOwn(env, "SURTEC_TEST_PLANNER_FAILURE_PROFILE", true).value === "1" && !failureOwn(env, "SURTEC_TEST_PLANNER_PROFILE", true).present && !failureOwn(env, "SURTEC_TEST_PLANNER_FS_PROFILE", true).present;
    if (enabled) limits = Object.hasOwn(dependencies, "sourceLimits") ? failureLimits(dependencies.sourceLimits) : preparePlannerFailureSourceLimits();
  } catch { enabled = false; }
  let emitted = false;
  return Object.freeze({ capture(context: unknown): void {
    if (!enabled || emitted) return;
    try { const receipt = projectPlannerFailureContext(context, limits); if (!receipt) return; emitted = true; const line = `${PLANNER_FAILURE_MARKER}${JSON.stringify(receipt)}\n`; if (Buffer.byteLength(line, "utf8") <= PLANNER_FAILURE_LINE_BYTES) (dependencies.write ?? ((text: string) => process.stdout.write(text)))(line); }
    catch { /* Evidence cannot replace or defer the original test/cleanup error. */ }
  } });
}
/** Strict DTO validation operates only on a detached bounded marker, never error payloads. */
export function sanitizePlannerFailureReceipt(value: unknown, sourceLimits?: PlannerFailureSourceLimits | null): PlannerFailureReceipt | null {
  try {
    const data = plainAggregate(value), keys = ["schema_version", "kind", "variant", "observation_point", "result_scope", "acceptance", "framework_state", "error_count", "errors", "capture_status", "classification_complete", "unavailable_reason"];
    if (!data || Object.keys(data).length !== keys.length || Object.keys(data).some((key) => !keys.includes(key)) || data.schema_version !== 1 || data.kind !== "planner-failure-observation" || data.variant !== "implementation" || data.observation_point !== "start-of-existing-root-afterEach" || data.result_scope !== "pre-cleanup-framework-result" || data.acceptance !== false || !["pass", "fail", "unavailable"].includes(data.framework_state as string) || !["captured", "unavailable"].includes(data.capture_status as string) || typeof data.classification_complete !== "boolean") return null;
    const errors = data.errors; if (!Array.isArray(errors) || nodeTypes.isProxy(errors)) return null;
    const length = failureOwn(errors, "length").value; if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > 8 || Reflect.ownKeys(errors).length !== (length as number) + 1) return null;
    if (data.capture_status === "unavailable") return data.framework_state === "unavailable" && data.error_count === null && length === 0 && data.classification_complete === false && (failureReasons as readonly unknown[]).includes(data.unavailable_reason) ? unavailableFailure(data.unavailable_reason as typeof failureReasons[number]) : null;
    if (data.unavailable_reason !== null || data.framework_state === "unavailable" || data.error_count !== length || data.framework_state === "pass" && length !== 0 || data.framework_state === "fail" && length === 0) return null;
    const limits = sourceLimits === undefined ? preparePlannerFailureSourceLimits() : failureLimits(sourceLimits), projected: PlannerFailureReceipt["errors"] = []; let siteCount = 0;
    for (let index = 0; index < (length as number); index++) {
      const entry = plainAggregate(failureOwn(errors, String(index)).value); if (!entry || Object.keys(entry).length !== 6 || Object.keys(entry).some((key) => !["index", "reported_name", "signature", "message", "sites", "positions_status"].includes(key)) || entry.index !== index || !(failureNames as readonly unknown[]).includes(entry.reported_name) || !["test-timeout-5000", "hook-timeout-10000", "unsupported"].includes(entry.signature as string) || !["available", "unavailable", "limit-reached"].includes(entry.positions_status as string)) return null;
      const expected = entry.signature === "test-timeout-5000" ? "Test timed out in 5000ms." : entry.signature === "hook-timeout-10000" ? "Hook timed out in 10000ms." : null; if (entry.message !== expected) return null;
      const sites = entry.sites; if (!Array.isArray(sites) || nodeTypes.isProxy(sites)) return null; const count = failureOwn(sites, "length").value;
      if (!Number.isSafeInteger(count) || (count as number) > 3 || Reflect.ownKeys(sites).length !== (count as number) + 1 || entry.positions_status === "unavailable" && count !== 0) return null;
      const positions: PlannerFailureReceipt["errors"][number]["sites"] = [];
      for (let position = 0; position < (count as number); position++) {
        const site = plainAggregate(failureOwn(sites, String(position)).value); if (!site || Object.keys(site).length !== 3 || Object.keys(site).some((key) => !["source", "line", "column"].includes(key)) || site.source !== "workflow-fixture" || !Number.isSafeInteger(site.line) || !Number.isSafeInteger(site.column) || !limits || (site.line as number) < 1 || (site.line as number) > limits.line_columns.length || (site.column as number) < 1 || (site.column as number) > limits.line_columns[(site.line as number) - 1]!) return null;
        if (++siteCount > 3) return null; positions.push(Object.freeze({ source: "workflow-fixture", line: site.line as number, column: site.column as number }));
      }
      projected.push(Object.freeze({ index, reported_name: entry.reported_name as typeof failureNames[number], signature: entry.signature as PlannerFailureReceipt["errors"][number]["signature"], message: expected, sites: Object.freeze(positions) as unknown as typeof positions, positions_status: entry.positions_status as PlannerFailureReceipt["errors"][number]["positions_status"] }));
    }
    if (data.classification_complete !== projected.every((entry) => entry.signature !== "unsupported")) return null;
    return Object.freeze({ schema_version: 1, kind: "planner-failure-observation", variant: "implementation", observation_point: "start-of-existing-root-afterEach", result_scope: "pre-cleanup-framework-result", acceptance: false, framework_state: data.framework_state as "pass" | "fail", error_count: length as number, errors: Object.freeze(projected) as unknown as typeof projected, capture_status: "captured", classification_complete: data.classification_complete, unavailable_reason: null });
  } catch { return null; }
}
function parseFailureReceiptLine(line: Buffer, limits: PlannerFailureSourceLimits | null): PlannerFailureReceipt | null {
  try {
    const decoded = line.toString("utf8"); if (!Buffer.from(decoded, "utf8").equals(line)) return null;
    const raw = decoded.replace(/\r$/, "").slice(PLANNER_FAILURE_MARKER.length), value: unknown = JSON.parse(raw), scopes: Array<Set<string>> = [];
    for (let index = 0; index < raw.length; index++) {
      if (raw[index] === "{") scopes.push(new Set()); else if (raw[index] === "}") scopes.pop();
      else if (raw[index] === '"') { const start = index++; for (; index < raw.length; index++) { if (raw[index] === "\\") index++; else if (raw[index] === '"') break; }
        let next = index + 1; while (next < raw.length && /\s/.test(raw[next]!)) next++;
        if (raw[next] === ":") { const key = JSON.parse(raw.slice(start, index + 1)) as string, scope = scopes.at(-1); if (!scope || scope.has(key)) return null; scope.add(key); }
      }
    }
    return sanitizePlannerFailureReceipt(value, limits);
  } catch { return null; }
}
/** Incremental byte ceiling includes marker and newline, including split UTF-8 input. */
export function createPlannerFailureMarkerCollector(progress: (receipt: PlannerFailureReceipt | null) => void = () => {}, sourceLimits?: PlannerFailureSourceLimits | null): { push(chunk: Buffer | string): void; finish(): PlannerFailureReceipt | null } {
  const limits = sourceLimits === undefined ? preparePlannerFailureSourceLimits() : failureLimits(sourceLimits), prefix = Buffer.from(PLANNER_FAILURE_MARKER);
  let bytes: number[] = [], discarded = false, markers = 0, invalid = false, receipt: PlannerFailureReceipt | null = null, finished = false;
  const isMarker = () => bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
  const notify = (value: PlannerFailureReceipt | null) => { try { progress(value); } catch { invalid = true; } };
  return {
    push(chunk: Buffer | string): void {
      if (finished) { invalid = true; notify(null); return; }
      const input = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      for (const byte of input) {
        if (byte === 10) {
          if (!discarded && isMarker()) { markers++; receipt = markers === 1 ? parseFailureReceiptLine(Buffer.from(bytes), limits) : null; if (!receipt) invalid = true; notify(invalid ? null : receipt); }
          bytes = []; discarded = false; continue;
        }
        if (discarded) continue;
        bytes.push(byte);
        if (markers > 0 && !invalid && isMarker()) { invalid = true; notify(null); }
        if (bytes.length + 1 > PLANNER_FAILURE_LINE_BYTES) { if (isMarker()) { invalid = true; notify(null); } bytes = []; discarded = true; }
      }
    },
    finish(): PlannerFailureReceipt | null { if (!finished && (isMarker() || bytes.length > 0 && bytes.length < prefix.length && bytes.every((byte, index) => byte === prefix[index]))) { invalid = true; notify(null); } finished = true; return markers === 1 && !invalid ? receipt : null; },
  };
}
export function parsePlannerFailureOutput(output: string, sourceLimits?: PlannerFailureSourceLimits | null): PlannerFailureReceipt | null { const collector = createPlannerFailureMarkerCollector(undefined, sourceLimits); collector.push(output); return collector.finish(); }

export interface PlannerFailureSourceMetadata { role: "planner-failure-source"; fixture_sha256: string; sourceLimits: PlannerFailureSourceLimits }
/** Source bounds and identity share one public source buffer, outside capture. */
function preparePlannerFailureSourceMetadata(): PlannerFailureSourceMetadata | null {
  try {
    const bytes = fs.readFileSync(join(repository, "runner/workflow-orchestrator.test.ts")); if (bytes.length > 1024 * 1024) return null;
    const source = bytes.toString("utf8"); if (!Buffer.from(source, "utf8").equals(bytes)) return null;
    const sourceLimits = failureLimits({ line_columns: source.split(/\r?\n/).map((line) => line.length + 1) }); if (!sourceLimits) return null;
    return Object.freeze({ role: "planner-failure-source", fixture_sha256: createHash("sha256").update(bytes).digest("hex"), sourceLimits });
  } catch { return null; }
}
/** Private metadata is closed and finite; no caller-supplied path is accepted. */
export function sanitizePlannerFailureSourceMetadata(value: unknown): PlannerFailureSourceMetadata | null {
  try {
    const data = plainAggregate(value); if (!data || Object.keys(data).length !== 3 || Object.keys(data).some((key) => !["role", "fixture_sha256", "sourceLimits"].includes(key)) || data.role !== "planner-failure-source" || typeof data.fixture_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.fixture_sha256)) return null;
    const raw = plainAggregate(data.sourceLimits); if (!raw || Object.keys(raw).length !== 1 || !Object.hasOwn(raw, "line_columns")) return null;
    const array = raw.line_columns; if (!Array.isArray(array) || nodeTypes.isProxy(array)) return null; const length = failureOwn(array, "length").value;
    if (!Number.isSafeInteger(length) || (length as number) < 1 || (length as number) > 10_000 || Reflect.ownKeys(array).length !== (length as number) + 1) return null;
    const sourceLimits = failureLimits(raw); if (!sourceLimits) return null;
    return Object.freeze({ role: "planner-failure-source", fixture_sha256: data.fixture_sha256, sourceLimits });
  } catch { return null; }
}
export interface PlannerFailureDiagnosticReport {
  schema_version: 1; workload: "first-planner-failure"; diagnostic_only: true; acceptance: false; status: "completed" | "failed" | "deadline"; wall_ms: number;
  wall_limit_ms: number; cleanup_reserve_ms: number; source_hashes: Record<string, string>; source_hashes_after: Record<string, string>; source_drift: boolean | null;
  receipt: PlannerFailureReceipt | null; suite: PlannerFsDiagnosticReport["suite"]; first_planner: PlannerFsDiagnosticReport["first_planner"]; cleanup: PlannerFsDiagnosticReport["cleanup"]; limitations: string[];
}
const failureDiagnosticLimitations = ["The receipt observes already recorded framework state at the start of the existing root afterEach, before this fixture's own cleanup, not callback-only or final task/test state.", "Recognized complete Test-5000/Hook-10000 messages are reported signatures, not unforgeable provenance or causal attribution; only canonical public first sentences are emitted.", "At most three bounded reported fixture-source sites across the receipt are selected from at most 128 lines per error; timeout sites may identify registration, not the blocking operation.", "Native emission is one bounded best-effort write, not delivery, flush or asynchronous pipe-error neutralization; missing, partial or invalid markers remain unavailable.", "One original complete Vitest workload keeps its original workers and limits; early evidence never proves suite, later state, source-after, cleanup or T015 acceptance."];
export function plannerFailureEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv { return { ...profileEnvironment(source), SURTEC_TEST_PLANNER_FAILURE_PROFILE: "1" }; }
export function plannerFailureArguments(): string[] { return [join(repository, "node_modules/vitest/vitest.mjs"), "run", "--reporter=json"]; }
function failureUnavailableReport(deadline: ProfileDeadline, expired = false, receipt: PlannerFailureReceipt | null = null): PlannerFailureDiagnosticReport {
  return { schema_version: 1, workload: "first-planner-failure", diagnostic_only: true, acceptance: false, status: expired ? "deadline" : "failed", wall_ms: deadline.elapsed(), wall_limit_ms: PROFILE_LIMIT_MS, cleanup_reserve_ms: PROFILE_CLEANUP_RESERVE_MS, source_hashes: {}, source_hashes_after: {}, source_drift: null, receipt, suite: null, first_planner: null, cleanup: "unavailable-no-uncertain-fixture-deleted", limitations: [...failureDiagnosticLimitations] };
}
/** The outer watchdog supplies validated private bounds; this projection does no FS work. */
export function sanitizePlannerFailureDiagnostic(value: unknown, sourceLimits?: PlannerFailureSourceLimits | null): PlannerFailureDiagnosticReport | null {
  try {
    const data = plainAggregate(value), keys = ["schema_version", "workload", "diagnostic_only", "acceptance", "status", "wall_ms", "wall_limit_ms", "cleanup_reserve_ms", "source_hashes", "source_hashes_after", "source_drift", "receipt", "suite", "first_planner", "cleanup", "limitations"];
    if (!data || Object.keys(data).length !== keys.length || Object.keys(data).some((key) => !keys.includes(key)) || data.schema_version !== 1 || data.workload !== "first-planner-failure" || data.diagnostic_only !== true || data.acceptance !== false || !["completed", "failed", "deadline"].includes(data.status as string) || !finite(data.wall_ms) || data.wall_limit_ms !== PROFILE_LIMIT_MS || data.cleanup_reserve_ms !== PROFILE_CLEANUP_RESERVE_MS || ![true, false, null].includes(data.source_drift as boolean | null)) return null;
    const hashes = (input: unknown): Record<string, string> | null => { const raw = plainAggregate(input); if (!raw) return null; const projected: Record<string, string> = {}; for (const [path, hash] of Object.entries(raw)) { if (!fsDiagnosticSources.includes(path) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return null; projected[path] = hash; } return projected; };
    const source_hashes = hashes(data.source_hashes), source_hashes_after = hashes(data.source_hashes_after), receipt = data.receipt === null ? null : sanitizePlannerFailureReceipt(data.receipt, sourceLimits ?? null);
    if (!source_hashes || !source_hashes_after || data.receipt !== null && !receipt || !["verified-normal-suite-and-no-new-planner-prefix-roots", "unavailable-no-uncertain-fixture-deleted"].includes(data.cleanup as string)) return null;
    let suite: PlannerFailureDiagnosticReport["suite"] = null, first_planner: PlannerFailureDiagnosticReport["first_planner"] = null;
    if (data.suite !== null) {
      const item = plainAggregate(data.suite); if (!item || Object.keys(item).length !== 5 || Object.keys(item).some((key) => !["passed", "passed_tests", "failed_tests", "skipped_tests", "test_ms"].includes(key)) || typeof item.passed !== "boolean" || !finite(item.test_ms)) return null;
      for (const name of ["passed_tests", "failed_tests", "skipped_tests"]) if (!finite(item[name]) || !Number.isSafeInteger(item[name])) return null;
      suite = { passed: item.passed, passed_tests: item.passed_tests as number, failed_tests: item.failed_tests as number, skipped_tests: item.skipped_tests as number, test_ms: item.test_ms };
    }
    if (data.first_planner !== null) { const item = plainAggregate(data.first_planner); if (!item || Object.keys(item).length !== 2 || Object.keys(item).some((key) => !["passed", "test_ms"].includes(key)) || typeof item.passed !== "boolean" || !finite(item.test_ms)) return null; first_planner = { passed: item.passed, test_ms: item.test_ms }; }
    if (suite?.passed && (suite.passed_tests === 0 || suite.failed_tests > 0) || first_planner?.passed && (!suite || suite.passed_tests === 0) || first_planner?.passed === false && (!suite || suite.failed_tests === 0)) return null;
    if (data.source_drift !== null && data.source_drift !== sourceHashesChanged(source_hashes, source_hashes_after)) return null;
    if (data.cleanup === "verified-normal-suite-and-no-new-planner-prefix-roots" && (!suite?.passed || !first_planner?.passed)) return null;
    if (data.status === "completed" && (data.wall_ms > PROFILE_LIMIT_MS || receipt?.capture_status !== "captured" || !suite?.passed || !first_planner?.passed || data.source_drift !== false || Object.keys(source_hashes).length !== fsDiagnosticSources.length || data.cleanup !== "verified-normal-suite-and-no-new-planner-prefix-roots")) return null;
    return { schema_version: 1, workload: "first-planner-failure", diagnostic_only: true, acceptance: false, status: data.status as PlannerFailureDiagnosticReport["status"], wall_ms: data.wall_ms, wall_limit_ms: PROFILE_LIMIT_MS, cleanup_reserve_ms: PROFILE_CLEANUP_RESERVE_MS, source_hashes, source_hashes_after, source_drift: data.source_drift as boolean | null, receipt, suite, first_planner, cleanup: data.cleanup as PlannerFailureDiagnosticReport["cleanup"], limitations: [...failureDiagnosticLimitations] };
  } catch { return null; }
}
async function runLoadedPlannerFailure(deadline: ProfileDeadline, metadata: (value: PlannerFailureSourceMetadata) => void, progress: (value: PlannerFailureDiagnosticReport) => void): Promise<PlannerFailureDiagnosticReport> {
  const report = failureUnavailableReport(deadline); let output = "", outputBytes = 0, oversized = false;
  try {
    report.source_hashes = sourceHashes(fsDiagnosticSources); const source = preparePlannerFailureSourceMetadata();
    if (!source || source.fixture_sha256 !== report.source_hashes["runner/workflow-orchestrator.test.ts"]) return report;
    metadata(source); const before = prefixInventory("surtec-workflow-worker-");
    if (!deadline.mayLaunch()) { report.status = "deadline"; return report; }
    const collector = createPlannerFailureMarkerCollector((receipt) => { report.receipt = receipt; progress({ ...report, wall_ms: deadline.elapsed() }); }, source.sourceLimits);
    const child = spawn(process.execPath, plannerFailureArguments(), { cwd: repository, env: plannerFailureEnvironment(process.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true }), pending = superviseChild(child, deadline);
    child.stdout?.on("data", (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes <= OUTPUT_LIMIT) output += chunk.toString(); else oversized = true; collector.push(chunk); }); child.stderr?.on("data", () => {});
    const outcome = await pending; report.receipt = collector.finish(); const summary = summarizeLoadedVitestOutput(output); report.suite = summary.suite; report.first_planner = summary.first_planner;
    report.status = outcome.expired ? "deadline" : "failed";
    const normal = outcome.closed && !outcome.expired && !outcome.failed && !oversized && outcome.exit_code === 0;
    if (normal && report.suite?.passed && report.first_planner?.passed && [...prefixInventory("surtec-workflow-worker-")].every((name) => before.has(name))) report.cleanup = "verified-normal-suite-and-no-new-planner-prefix-roots";
    if (deadline.remaining() > 0) { report.source_hashes_after = sourceHashes(fsDiagnosticSources); report.source_drift = sourceHashesChanged(report.source_hashes, report.source_hashes_after); }
    if (normal && report.receipt?.capture_status === "captured" && report.suite?.passed && report.first_planner?.passed && report.source_drift === false && report.cleanup === "verified-normal-suite-and-no-new-planner-prefix-roots") report.status = "completed";
  } catch { report.status = deadline.remaining() <= 0 ? "deadline" : "failed"; }
  report.wall_ms = deadline.elapsed(); if (deadline.remaining() <= 0) { report.status = "deadline"; report.cleanup = "unavailable-no-uncertain-fixture-deleted"; } return report;
}
interface FailureControllerChild extends SupervisedChild { on(event: "message", listener: (value: unknown) => void): unknown; send(message: { role: "planner-failure-controller"; origin_ms: number }): unknown }
/** Responsive outer watchdog retains only source-bound early evidence from ordered private IPC. */
export async function runPlannerFailureDiagnosticWatchdog(deadline = new ProfileDeadline(), launch: () => FailureControllerChild = () => fork(script, [], { cwd: repository, execArgv: ["--import", "tsx"], env: profileEnvironment(process.env), stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true })): Promise<PlannerFailureDiagnosticReport> {
  if (!deadline.mayLaunch()) return failureUnavailableReport(deadline, true);
  let finalReport: PlannerFailureDiagnosticReport | null = null, partialReport: PlannerFailureDiagnosticReport | null = null, source: PlannerFailureSourceMetadata | null = null, sourceMessages = 0, invalidSource = false, revoked = false, firstReceipt: string | undefined;
  const received = (): { final: PlannerFailureDiagnosticReport | null; partial: PlannerFailureDiagnosticReport | null } => ({ final: finalReport, partial: partialReport });
  const validated = (value: unknown): PlannerFailureDiagnosticReport | null => {
    if (invalidSource || sourceMessages !== 1 || !source) return null;
    const report = sanitizePlannerFailureDiagnostic(value, source.sourceLimits); return report && report.source_hashes["runner/workflow-orchestrator.test.ts"] === source.fixture_sha256 ? report : null;
  };
  try {
    const controller = launch(), cancellation = new AbortController(), pending = superviseChild(controller, deadline, 1000, cancellation.signal, "cleanup");
    controller.stdout?.on?.("data", () => {}); controller.stderr?.on?.("data", () => {});
    controller.on("message", (value) => {
      const data = plainAggregate(value);
      if (data?.role === "planner-failure-source") { sourceMessages++; source = sourceMessages === 1 ? sanitizePlannerFailureSourceMetadata(value) : null; if (!source) invalidSource = true; }
      else if (data?.role === "planner-failure-report" || data?.role === "planner-failure-progress") {
        if (!source || sourceMessages !== 1 || Object.keys(data).length !== 2 || !Object.hasOwn(data, "report")) invalidSource = true;
        const report = validated(data.report);
        if (!report?.receipt) revoked = true;
        else { const detachedIdentity = JSON.stringify(report.receipt); if (firstReceipt === undefined) firstReceipt = detachedIdentity; else if (firstReceipt !== detachedIdentity) revoked = true; }
        if (data.role === "planner-failure-report") finalReport = report; else partialReport = report;
      } else invalidSource = true;
    });
    try { controller.send({ role: "planner-failure-controller", origin_ms: performance.timeOrigin }); } catch { cancellation.abort(); }
    const outcome = await pending, observations = received(), report = invalidSource || revoked ? null : observations.final, partial = invalidSource || revoked ? null : observations.partial;
    if (!outcome.closed || outcome.expired || outcome.failed || outcome.exit_code !== 0 || !report || deadline.remaining() <= 0) {
      const unavailable = failureUnavailableReport(deadline, outcome.expired || deadline.remaining() <= 0, partial?.receipt ?? null); unavailable.source_hashes = partial?.source_hashes ?? {}; return unavailable;
    }
    report.wall_ms = deadline.elapsed(); return report;
  } catch { const partial = invalidSource || revoked ? null : received().partial, unavailable = failureUnavailableReport(deadline, deadline.remaining() <= 0, partial?.receipt ?? null); unavailable.source_hashes = partial?.source_hashes ?? {}; return unavailable; }
}
async function plannerFailureControllerWorker(value: unknown): Promise<void> {
  try {
    const data = plainAggregate(value); if (!data || Object.keys(data).length !== 2 || data.role !== "planner-failure-controller" || !finite(data.origin_ms)) throw new Error();
    const origin = data.origin_ms, deadline = new ProfileDeadline(() => performance.timeOrigin + performance.now() - origin);
    const send = (message: unknown) => { if (!process.send || !process.connected) throw new Error(); process.send(message, () => {}); };
    const report = await runLoadedPlannerFailure(deadline, (source) => send(source), (partial) => send({ role: "planner-failure-progress", report: partial }));
    if (!process.send) throw new Error(); process.send({ role: "planner-failure-report", report }, (error) => { if (process.connected) process.disconnect(); process.exitCode = error ? 1 : 0; });
  } catch { if (process.connected) process.disconnect(); process.exitCode = 1; }
}

export const PLANNER_SPAN_PHASES = ["issue-create", "issue-authorize", "preview", "admission", "dispatch", "terminal-observation", "assertions", "probe-reconcile", "probe-worker-tick", "probe-restart-reconcile", "probe-assertions"] as const;
export type PlannerSpanPhase = typeof PLANNER_SPAN_PHASES[number];
export interface PlannerSpanObserver { begin(phase: PlannerSpanPhase): () => void }
export interface PlannerSpanRow { entries: 0 | 1; state: "not-observed" | "open" | "ended"; start_ms: number | null; end_ms: number | null; elapsed_ms: number | null }
type PlannerSpanUnavailableReason = "case-binding-unavailable" | "callback-start-not-observed" | "invalid-clock" | "invalid-span-sequence";
interface PlannerSpanCursorFields { measurement_scope: "callback-entry-observer-to-root-afterEach"; cleanup: "not-observed-at-this-point"; sealed: true }
export type PlannerSpanCursor = PlannerSpanCursorFields & ({ timing_status: "captured"; unavailable_reason: null; observation_elapsed_ms: number; phases: Record<PlannerSpanPhase, PlannerSpanRow>; cursor_phase: PlannerSpanPhase | "between-public-spans"; last_ended_phase: PlannerSpanPhase | null; between_spans_ms: number; cursor_elapsed_ms: number } | { timing_status: "unavailable"; unavailable_reason: PlannerSpanUnavailableReason; observation_elapsed_ms: null; phases: null; cursor_phase: null; last_ended_phase: null; between_spans_ms: null; cursor_elapsed_ms: null });
export interface PlannerSpanReceipt {
  schema_version: 1; kind: "planner-span-observation"; variant: "implementation"; observation_point: "start-of-existing-root-afterEach"; result_scope: "pre-cleanup-framework-result"; acceptance: false;
  failure_receipt: PlannerFailureReceipt; span_cursor: PlannerSpanCursor;
}
const PLANNER_SPAN_MARKER = "PLANNER_SPAN_PROFILE ", PLANNER_SPAN_LINE_BYTES = 8192;
const spanUnavailableReasons: readonly PlannerSpanUnavailableReason[] = ["case-binding-unavailable", "callback-start-not-observed", "invalid-clock", "invalid-span-sequence"];
function unavailableSpan(reason: PlannerSpanUnavailableReason): PlannerSpanCursor {
  return Object.freeze({ measurement_scope: "callback-entry-observer-to-root-afterEach", timing_status: "unavailable", unavailable_reason: reason, observation_elapsed_ms: null, phases: null, cursor_phase: null, last_ended_phase: null, between_spans_ms: null, cursor_elapsed_ms: null, cleanup: "not-observed-at-this-point", sealed: true });
}
function emptySpanRows(): Record<PlannerSpanPhase, PlannerSpanRow> {
  return Object.fromEntries(PLANNER_SPAN_PHASES.map((phase) => [phase, { entries: 0, state: "not-observed", start_ms: null, end_ms: null, elapsed_ms: null }])) as Record<PlannerSpanPhase, PlannerSpanRow>;
}
function spanTime(value: unknown): value is number { return finite(value) && value <= PROFILE_LIMIT_MS; }
/** Reconstruct the ordered partition from offsets, using the recorder's arithmetic. */
function capturedSpan(rows: Record<PlannerSpanPhase, PlannerSpanRow>, elapsed: number): PlannerSpanCursor | null {
  if (!spanTime(elapsed)) return null;
  let previousEnd = 0, gaps = 0, stopped = false, open: PlannerSpanPhase | null = null, lastEnded: PlannerSpanPhase | null = null;
  const phases = emptySpanRows();
  for (const phase of PLANNER_SPAN_PHASES) {
    const row = rows[phase];
    if (row.state === "not-observed") {
      if (row.entries !== 0 || row.start_ms !== null || row.end_ms !== null || row.elapsed_ms !== null) return null;
      stopped = true;
    } else {
      if (stopped || row.entries !== 1 || !spanTime(row.start_ms) || row.start_ms < previousEnd || row.start_ms > elapsed || !spanTime(row.elapsed_ms)) return null;
      gaps += row.start_ms - previousEnd;
      if (!spanTime(gaps)) return null;
      if (row.state === "open") {
        if (row.end_ms !== null || row.elapsed_ms !== elapsed - row.start_ms) return null;
        stopped = true; open = phase;
      } else if (row.state === "ended") {
        if (!spanTime(row.end_ms) || row.end_ms < row.start_ms || row.end_ms > elapsed || row.elapsed_ms !== row.end_ms - row.start_ms) return null;
        previousEnd = row.end_ms; lastEnded = phase;
      } else return null;
    }
    phases[phase] = Object.freeze({ entries: row.entries, state: row.state, start_ms: row.start_ms, end_ms: row.end_ms, elapsed_ms: row.elapsed_ms });
  }
  if (!open) gaps += elapsed - previousEnd;
  if (!spanTime(gaps)) return null;
  return Object.freeze({ measurement_scope: "callback-entry-observer-to-root-afterEach", timing_status: "captured", unavailable_reason: null, observation_elapsed_ms: elapsed, phases: Object.freeze(phases), cursor_phase: open ?? "between-public-spans", last_ended_phase: lastEnded, between_spans_ms: gaps, cursor_elapsed_ms: open ? elapsed - phases[open].start_ms! : elapsed - previousEnd, cleanup: "not-observed-at-this-point", sealed: true });
}
/** Closed detached timing DTO: no private task or clock identity crosses this boundary. */
export function sanitizePlannerSpanCursor(value: unknown): PlannerSpanCursor | null {
  try {
    const data = plainAggregate(value), keys = ["measurement_scope", "timing_status", "unavailable_reason", "observation_elapsed_ms", "phases", "cursor_phase", "last_ended_phase", "between_spans_ms", "cursor_elapsed_ms", "cleanup", "sealed"];
    if (!data || Object.keys(data).length !== keys.length || Object.keys(data).some((key) => !keys.includes(key)) || data.measurement_scope !== "callback-entry-observer-to-root-afterEach" || data.cleanup !== "not-observed-at-this-point" || data.sealed !== true) return null;
    if (data.timing_status === "unavailable") {
      if (!spanUnavailableReasons.includes(data.unavailable_reason as PlannerSpanUnavailableReason) || ["observation_elapsed_ms", "phases", "cursor_phase", "last_ended_phase", "between_spans_ms", "cursor_elapsed_ms"].some((key) => data[key] !== null)) return null;
      return unavailableSpan(data.unavailable_reason as PlannerSpanUnavailableReason);
    }
    if (data.timing_status !== "captured" || data.unavailable_reason !== null || !spanTime(data.observation_elapsed_ms)) return null;
    const table = plainAggregate(data.phases); if (!table || Object.keys(table).length !== PLANNER_SPAN_PHASES.length || Object.keys(table).some((key) => !(PLANNER_SPAN_PHASES as readonly string[]).includes(key))) return null;
    const phases = emptySpanRows();
    for (const phase of PLANNER_SPAN_PHASES) {
      const row = plainAggregate(table[phase]); if (!row || Object.keys(row).length !== 5 || Object.keys(row).some((key) => !["entries", "state", "start_ms", "end_ms", "elapsed_ms"].includes(key)) || ![0, 1].includes(row.entries as number) || !["not-observed", "open", "ended"].includes(row.state as string)) return null;
      phases[phase] = { entries: row.entries as 0 | 1, state: row.state as PlannerSpanRow["state"], start_ms: row.start_ms as number | null, end_ms: row.end_ms as number | null, elapsed_ms: row.elapsed_ms as number | null };
    }
    const reconstructed = capturedSpan(phases, data.observation_elapsed_ms);
    if (!reconstructed || reconstructed.timing_status !== "captured" || data.cursor_phase !== reconstructed.cursor_phase || data.last_ended_phase !== reconstructed.last_ended_phase || data.between_spans_ms !== reconstructed.between_spans_ms || data.cursor_elapsed_ms !== reconstructed.cursor_elapsed_ms) return null;
    return reconstructed;
  } catch { return null; }
}
export function sanitizePlannerSpanReceipt(value: unknown, sourceLimits?: PlannerFailureSourceLimits | null): PlannerSpanReceipt | null {
  try {
    const data = plainAggregate(value), keys = ["schema_version", "kind", "variant", "observation_point", "result_scope", "acceptance", "failure_receipt", "span_cursor"];
    if (!data || Object.keys(data).length !== keys.length || Object.keys(data).some((key) => !keys.includes(key)) || data.schema_version !== 1 || data.kind !== "planner-span-observation" || data.variant !== "implementation" || data.observation_point !== "start-of-existing-root-afterEach" || data.result_scope !== "pre-cleanup-framework-result" || data.acceptance !== false) return null;
    const failure_receipt = sanitizePlannerFailureReceipt(data.failure_receipt, sourceLimits), span_cursor = sanitizePlannerSpanCursor(data.span_cursor); if (!failure_receipt || !span_cursor) return null;
    return Object.freeze({ schema_version: 1, kind: "planner-span-observation", variant: "implementation", observation_point: "start-of-existing-root-afterEach", result_scope: "pre-cleanup-framework-result", acceptance: false, failure_receipt, span_cursor });
  } catch { return null; }
}
function spanTask(context: unknown, counters = true): object | null {
  try {
    const task = failureOwn(context, "task", true).value; if (!failurePayload(task)) return null;
    const file = failureOwn(task, "file").value, name = failureOwn(task, "name").value; if (name !== PLANNER_FAILURE_CASE || !failurePayload(file)) return null;
    const filepath = failureOwn(file, "filepath").value; if (!failureString(filepath, 1024) || filepath.replace(/\\/g, "/") !== failureFixturePath) return null;
    if (counters) { const result = failureOwn(task, "result").value; if (!failurePayload(result) || failureOwn(result, "retryCount").value !== 0 || failureOwn(result, "repeatCount").value !== 0) return null; }
    return task as object;
  } catch { return null; }
}
interface PlannerSpanCaptureDependencies { env?: NodeJS.ProcessEnv; write?: (line: string) => unknown; sourceLimits?: PlannerFailureSourceLimits | null; clock?: () => number }
/** Before-hook binding is private; only a callback-local observer can advance its handle. */
export function createPlannerSpanCapture(dependencies: PlannerSpanCaptureDependencies = {}): { prepare(context: unknown): void; beginCallback(): PlannerSpanObserver | undefined; capture(context: unknown): void } {
  let enabled = false, limits: PlannerFailureSourceLimits | null = null;
  try {
    const env = dependencies.env ?? process.env;
    if (!env || typeof env !== "object" || nodeTypes.isProxy(env)) throw new Error();
    enabled = failureOwn(env, "SURTEC_TEST_PLANNER_SPAN_PROFILE", true).value === "1" && !["SURTEC_TEST_PLANNER_PROFILE", "SURTEC_TEST_PLANNER_FS_PROFILE", "SURTEC_TEST_PLANNER_FAILURE_PROFILE"].some((key) => failureOwn(env, key, true).present);
    if (enabled) limits = Object.hasOwn(dependencies, "sourceLimits") ? failureLimits(dependencies.sourceLimits) : preparePlannerFailureSourceLimits();
  } catch { enabled = false; }
  interface Handle { started: boolean; consumed: boolean; origin?: number; last?: number; reason?: PlannerSpanUnavailableReason; rows: Record<PlannerSpanPhase, PlannerSpanRow>; next: number; gaps: number; gapStart: number; open?: PlannerSpanPhase; sealed?: PlannerSpanCursor; observer: PlannerSpanObserver }
  const handles = new WeakMap<object, Handle>(), clock = dependencies.clock ?? performance.now.bind(performance);
  let slot: Handle | undefined, active: Handle | undefined, emitted = false, hasBinding = false;
  const invalidate = (handle: Handle, reason: PlannerSpanUnavailableReason) => { if (!handle.sealed && !handle.reason) handle.reason = reason; };
  const now = (handle: Handle): number | undefined => {
    if (handle.sealed || handle.reason) return;
    try {
      const value = clock();
      if (!finite(value) || handle.last !== undefined && value < handle.last || handle.origin !== undefined && !spanTime(value - handle.origin)) { invalidate(handle, "invalid-clock"); return; }
      handle.last = value; if (handle.origin === undefined) handle.origin = value; return value - handle.origin;
    } catch { invalidate(handle, "invalid-clock"); return; }
  };
  const makeHandle = (): Handle => {
    const handle: Handle = { started: false, consumed: false, rows: emptySpanRows(), next: 0, gaps: 0, gapStart: 0, observer: Object.freeze({ begin: (phase: PlannerSpanPhase): (() => void) => {
      if (handle.sealed || handle.reason) return () => {};
      if (!handle.started || handle.open || PLANNER_SPAN_PHASES[handle.next] !== phase) { invalidate(handle, "invalid-span-sequence"); return () => {}; }
      const start = now(handle); if (start === undefined) return () => {};
      handle.gaps += start - handle.gapStart;
      handle.rows[phase] = { entries: 1, state: "open", start_ms: start, end_ms: null, elapsed_ms: null }; handle.open = phase; handle.next++;
      let ended = false;
      return () => {
        if (handle.sealed || handle.reason) return;
        if (ended || handle.open !== phase) { invalidate(handle, "invalid-span-sequence"); return; } ended = true;
        const end = now(handle); if (end === undefined) return;
        handle.rows[phase] = { entries: 1, state: "ended", start_ms: start, end_ms: end, elapsed_ms: end - start }; handle.open = undefined; handle.gapStart = end;
      };
    } }) };
    return handle;
  };
  return Object.freeze({
    prepare(context: unknown): void {
      if (!enabled) return;
      try {
        if (slot) invalidate(slot, "case-binding-unavailable"); slot = undefined;
        if (active) invalidate(active, "case-binding-unavailable"); active = undefined;
        if (emitted) return;
        const task = spanTask(context); if (!task) return;
        const prior = handles.get(task); if (prior) { invalidate(prior, "case-binding-unavailable"); return; }
        const handle = makeHandle(); handles.set(task, handle); hasBinding = true; slot = handle;
      } catch { slot = undefined; }
    },
    beginCallback(): PlannerSpanObserver | undefined {
      if (!enabled || emitted) return;
      try {
        const handle = slot; slot = undefined;
        if (!handle) { if (active) invalidate(active, "case-binding-unavailable"); return; }
        if (handle.consumed || handle.sealed) { invalidate(handle, "case-binding-unavailable"); return; }
        handle.consumed = true; handle.started = true; active = handle; now(handle); return handle.observer;
      } catch { return; }
    },
    capture(context: unknown): void {
      if (!enabled || emitted) return;
      try {
        const task = spanTask(context, false); if (!task) return;
        const handle = handles.get(task), bound = spanTask(context) === task;
        if (!handle && hasBinding) return;
        let span_cursor: PlannerSpanCursor;
        if (handle?.sealed) span_cursor = handle.sealed;
        else if (!bound || !handle) { span_cursor = unavailableSpan("case-binding-unavailable"); if (handle) handle.sealed = span_cursor; }
        else {
          let elapsed: number | undefined;
          if (!handle.reason && handle.started) elapsed = now(handle);
          if (handle.reason) span_cursor = unavailableSpan(handle.reason);
          else if (!handle.started || elapsed === undefined) span_cursor = unavailableSpan("callback-start-not-observed");
          else {
            if (handle.open) { const row = handle.rows[handle.open]; row.elapsed_ms = elapsed - row.start_ms!; }
            const reconstructed = capturedSpan(handle.rows, elapsed), gaps = handle.gaps + (handle.open ? 0 : elapsed - handle.gapStart);
            span_cursor = reconstructed?.timing_status === "captured" && reconstructed.between_spans_ms === gaps ? reconstructed : unavailableSpan("invalid-span-sequence");
          }
          handle.sealed = span_cursor;
        }
        const failure_receipt = projectPlannerFailureContext(context, limits); if (!failure_receipt) return;
        emitted = true;
        const receipt: PlannerSpanReceipt = Object.freeze({ schema_version: 1, kind: "planner-span-observation", variant: "implementation", observation_point: "start-of-existing-root-afterEach", result_scope: "pre-cleanup-framework-result", acceptance: false, failure_receipt, span_cursor });
        const line = `${PLANNER_SPAN_MARKER}${JSON.stringify(receipt)}\n`;
        if (Buffer.byteLength(line, "utf8") <= PLANNER_SPAN_LINE_BYTES) (dependencies.write ?? ((text: string) => process.stdout.write(text)))(line);
      } catch { /* Observer evidence never replaces the original test or cleanup error. */ }
    },
  });
}

function parseSpanReceiptLine(line: Buffer, limits: PlannerFailureSourceLimits | null): PlannerSpanReceipt | null {
  try {
    const decoded = line.toString("utf8"); if (!Buffer.from(decoded, "utf8").equals(line)) return null;
    const raw = decoded.replace(/\r$/, "").slice(PLANNER_SPAN_MARKER.length), value: unknown = JSON.parse(raw), scopes: Array<Set<string>> = [];
    for (let index = 0; index < raw.length; index++) {
      if (raw[index] === "{") scopes.push(new Set()); else if (raw[index] === "}") scopes.pop();
      else if (raw[index] === '"') { const start = index++; for (; index < raw.length; index++) { if (raw[index] === "\\") index++; else if (raw[index] === '"') break; }
        let next = index + 1; while (next < raw.length && /\s/.test(raw[next]!)) next++;
        if (raw[next] === ":") { const encodedKey = raw.slice(start, index + 1); if (encodedKey.includes("\\")) return null; const key = JSON.parse(encodedKey) as string, scope = scopes.at(-1); if (!scope || scope.has(key)) return null; scope.add(key); }
      }
    }
    return sanitizePlannerSpanReceipt(value, limits);
  } catch { return null; }
}
/** Incremental UTF-8 validation and one line byte budget include prefix and LF. */
export function createPlannerSpanMarkerCollector(progress: (receipt: PlannerSpanReceipt | null) => void = () => {}, sourceLimits?: PlannerFailureSourceLimits | null): { push(chunk: Buffer | string): void; finish(): PlannerSpanReceipt | null } {
  const limits = sourceLimits === undefined ? preparePlannerFailureSourceLimits() : failureLimits(sourceLimits), prefix = Buffer.from(PLANNER_SPAN_MARKER);
  let bytes: number[] = [], discarded = false, markers = 0, invalid = false, receipt: PlannerSpanReceipt | null = null, finished = false;
  const isMarker = () => bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
  const isPartialMarker = () => bytes.length > 0 && bytes.length < prefix.length && bytes.every((byte, index) => byte === prefix[index]);
  const notify = (value: PlannerSpanReceipt | null) => { try { progress(value); } catch { invalid = true; } };
  return {
    push(chunk: Buffer | string): void {
      if (finished) { invalid = true; notify(null); return; }
      const input = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      for (const byte of input) {
        if (byte === 10) {
          if (!discarded && isMarker()) { markers++; receipt = markers === 1 ? parseSpanReceiptLine(Buffer.from(bytes), limits) : null; if (!receipt) invalid = true; notify(invalid ? null : receipt); }
          else if (!discarded && isPartialMarker()) { invalid = true; notify(null); }
          bytes = []; discarded = false; continue;
        }
        if (discarded) continue;
        bytes.push(byte);
        if (markers > 0 && !invalid && isMarker()) { invalid = true; notify(null); }
        if (bytes.length + 1 > PLANNER_SPAN_LINE_BYTES) { if (isMarker()) { invalid = true; notify(null); } bytes = []; discarded = true; }
      }
    },
    finish(): PlannerSpanReceipt | null { if (!finished && (isMarker() || isPartialMarker())) { invalid = true; notify(null); } finished = true; return markers === 1 && !invalid ? receipt : null; },
  };
}
export function parsePlannerSpanOutput(output: string, sourceLimits?: PlannerFailureSourceLimits | null): PlannerSpanReceipt | null { const collector = createPlannerSpanMarkerCollector(undefined, sourceLimits); collector.push(output); return collector.finish(); }
export interface PlannerSpanSourceMetadata { role: "planner-span-source"; fixture_sha256: string; sourceLimits: PlannerFailureSourceLimits }
function preparePlannerSpanSourceMetadata(): PlannerSpanSourceMetadata | null {
  const source = preparePlannerFailureSourceMetadata(); return source ? Object.freeze({ role: "planner-span-source", fixture_sha256: source.fixture_sha256, sourceLimits: source.sourceLimits }) : null;
}
export function sanitizePlannerSpanSourceMetadata(value: unknown): PlannerSpanSourceMetadata | null {
  try {
    const data = plainAggregate(value); if (!data || Object.keys(data).length !== 3 || Object.keys(data).some((key) => !["role", "fixture_sha256", "sourceLimits"].includes(key)) || data.role !== "planner-span-source") return null;
    const source = sanitizePlannerFailureSourceMetadata({ role: "planner-failure-source", fixture_sha256: data.fixture_sha256, sourceLimits: data.sourceLimits });
    return source ? Object.freeze({ role: "planner-span-source", fixture_sha256: source.fixture_sha256, sourceLimits: source.sourceLimits }) : null;
  } catch { return null; }
}
export interface PlannerSpanDiagnosticReport {
  schema_version: 1; workload: "first-planner-spans"; diagnostic_only: true; acceptance: false; status: "completed" | "failed" | "deadline"; wall_ms: number;
  wall_limit_ms: number; cleanup_reserve_ms: number; source_hashes: Record<string, string>; source_hashes_after: Record<string, string>; source_drift: boolean | null;
  receipt: PlannerSpanReceipt | null; suite: PlannerFsDiagnosticReport["suite"]; first_planner: PlannerFsDiagnosticReport["first_planner"]; cleanup: PlannerFsDiagnosticReport["cleanup"]; limitations: string[];
}
const spanDiagnosticLimitations = ["The observation window starts at the callback-entry observer and ends at the existing root afterEach before this fixture's cleanup; it includes observer overhead, unmarked work and framework or nested-hook delivery.", "An ended public span records a finally boundary, not success; an open span only means its end marker was not yet observed, not a blocking operation or cause. Unattributed between-span intervals are not CPU or filesystem measurements.", "The unchanged P08 failure projection reports complete public Test-5000 or Hook-10000 signatures, not unforgeable provenance or causal attribution; private errors and identities never leave the worker.", "One immutable combined envelope is emitted through one bounded best-effort native write; delivery, flushing and asynchronous pipe errors remain unavailable. Transport revocation differs from harmless ignored late local observer calls.", "One original complete Vitest workload retains its workers, operations, assertions and limits; partial evidence never proves final case/suite, source-after, cleanup or T015 acceptance."];
export function plannerSpanEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv { return { ...profileEnvironment(source), SURTEC_TEST_PLANNER_SPAN_PROFILE: "1" }; }
export function plannerSpanArguments(): string[] { return [join(repository, "node_modules/vitest/vitest.mjs"), "run", "--reporter=json"]; }
function spanUnavailableReport(deadline: ProfileDeadline, expired = false, receipt: PlannerSpanReceipt | null = null): PlannerSpanDiagnosticReport {
  return { schema_version: 1, workload: "first-planner-spans", diagnostic_only: true, acceptance: false, status: expired ? "deadline" : "failed", wall_ms: deadline.elapsed(), wall_limit_ms: PROFILE_LIMIT_MS, cleanup_reserve_ms: PROFILE_CLEANUP_RESERVE_MS, source_hashes: {}, source_hashes_after: {}, source_drift: null, receipt, suite: null, first_planner: null, cleanup: "unavailable-no-uncertain-fixture-deleted", limitations: [...spanDiagnosticLimitations] };
}
/** Pure IPC projection: the caller supplies the validated public source bounds. */
export function sanitizePlannerSpanDiagnostic(value: unknown, sourceLimits?: PlannerFailureSourceLimits | null): PlannerSpanDiagnosticReport | null {
  try {
    const data = plainAggregate(value); if (!data || data.workload !== "first-planner-spans") return null;
    const receipt = data.receipt === null ? null : sanitizePlannerSpanReceipt(data.receipt, sourceLimits ?? null); if (data.receipt !== null && !receipt) return null;
    const common = sanitizePlannerFailureDiagnostic({ ...data, workload: "first-planner-failure", receipt: receipt?.failure_receipt ?? null }, sourceLimits ?? null); if (!common) return null;
    if (common.status === "completed" && (receipt?.failure_receipt.framework_state !== "pass" || receipt.span_cursor.timing_status !== "captured" || !PLANNER_SPAN_PHASES.every((phase) => receipt.span_cursor.timing_status === "captured" && receipt.span_cursor.phases[phase].state === "ended"))) return null;
    return { ...common, workload: "first-planner-spans", receipt, limitations: [...spanDiagnosticLimitations] };
  } catch { return null; }
}
async function runLoadedPlannerSpan(deadline: ProfileDeadline, metadata: (value: PlannerSpanSourceMetadata) => void, progress: (value: PlannerSpanDiagnosticReport) => void): Promise<PlannerSpanDiagnosticReport> {
  const report = spanUnavailableReport(deadline); let output = "", outputBytes = 0, oversized = false;
  try {
    report.source_hashes = sourceHashes(fsDiagnosticSources); const source = preparePlannerSpanSourceMetadata();
    if (!source || source.fixture_sha256 !== report.source_hashes["runner/workflow-orchestrator.test.ts"]) return report;
    metadata(source); const before = prefixInventory("surtec-workflow-worker-");
    if (!deadline.mayLaunch()) { report.status = "deadline"; return report; }
    const collector = createPlannerSpanMarkerCollector((receipt) => { report.receipt = receipt; progress({ ...report, wall_ms: deadline.elapsed() }); }, source.sourceLimits);
    const child = spawn(process.execPath, plannerSpanArguments(), { cwd: repository, env: plannerSpanEnvironment(process.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true }), pending = superviseChild(child, deadline);
    child.stdout?.on("data", (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes <= OUTPUT_LIMIT) output += chunk.toString(); else oversized = true; collector.push(chunk); }); child.stderr?.on("data", () => {});
    const outcome = await pending; report.receipt = collector.finish(); const summary = summarizeLoadedVitestOutput(output); report.suite = summary.suite; report.first_planner = summary.first_planner;
    report.status = outcome.expired ? "deadline" : "failed";
    const normal = outcome.closed && !outcome.expired && !outcome.failed && !oversized && outcome.exit_code === 0;
    if (normal && report.suite?.passed && report.first_planner?.passed && [...prefixInventory("surtec-workflow-worker-")].every((name) => before.has(name))) report.cleanup = "verified-normal-suite-and-no-new-planner-prefix-roots";
    if (deadline.remaining() > 0) { report.source_hashes_after = sourceHashes(fsDiagnosticSources); report.source_drift = sourceHashesChanged(report.source_hashes, report.source_hashes_after); }
    if (normal && report.receipt?.failure_receipt.capture_status === "captured" && report.receipt.failure_receipt.framework_state === "pass" && report.receipt.span_cursor.timing_status === "captured" && PLANNER_SPAN_PHASES.every((phase) => report.receipt?.span_cursor.timing_status === "captured" && report.receipt.span_cursor.phases[phase].state === "ended") && report.suite?.passed && report.first_planner?.passed && report.source_drift === false && report.cleanup === "verified-normal-suite-and-no-new-planner-prefix-roots") report.status = "completed";
  } catch { report.status = deadline.remaining() <= 0 ? "deadline" : "failed"; }
  report.wall_ms = deadline.elapsed(); if (deadline.remaining() <= 0) { report.status = "deadline"; report.cleanup = "unavailable-no-uncertain-fixture-deleted"; } return report;
}
interface SpanControllerChild extends SupervisedChild { on(event: "message", listener: (value: unknown) => void): unknown; send(message: { role: "planner-span-controller"; origin_ms: number }): unknown }
/** The outer watchdog performs no filesystem work and immediately detaches IPC evidence. */
export async function runPlannerSpanDiagnosticWatchdog(deadline = new ProfileDeadline(), launch: () => SpanControllerChild = () => fork(script, [], { cwd: repository, execArgv: ["--import", "tsx"], env: profileEnvironment(process.env), stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true })): Promise<PlannerSpanDiagnosticReport> {
  if (!deadline.mayLaunch()) return spanUnavailableReport(deadline, true);
  let finalReport: PlannerSpanDiagnosticReport | null = null, partialReport: PlannerSpanDiagnosticReport | null = null, source: PlannerSpanSourceMetadata | null = null, sourceMessages = 0, revoked = false, finalSeen = false, firstReceipt: string | undefined;
  const received = (): { final: PlannerSpanDiagnosticReport | null; partial: PlannerSpanDiagnosticReport | null } => ({ final: finalReport, partial: partialReport });
  const validated = (value: unknown): PlannerSpanDiagnosticReport | null => {
    if (revoked || sourceMessages !== 1 || !source) return null;
    const report = sanitizePlannerSpanDiagnostic(value, source.sourceLimits); return report && report.source_hashes["runner/workflow-orchestrator.test.ts"] === source.fixture_sha256 ? report : null;
  };
  try {
    const controller = launch(), cancellation = new AbortController(), pending = superviseChild(controller, deadline, 1000, cancellation.signal, "cleanup");
    controller.stdout?.on?.("data", () => {}); controller.stderr?.on?.("data", () => {});
    controller.on("message", (value) => {
      const data = plainAggregate(value);
      if (data?.role === "planner-span-source") {
        sourceMessages++; if (sourceMessages !== 1 || finalSeen || firstReceipt !== undefined) revoked = true;
        source = sourceMessages === 1 ? sanitizePlannerSpanSourceMetadata(value) : null; if (!source) revoked = true;
      } else if (data?.role === "planner-span-report" || data?.role === "planner-span-progress") {
        if (finalSeen || !source || sourceMessages !== 1 || Object.keys(data).length !== 2 || !Object.hasOwn(data, "report")) revoked = true;
        const report = validated(data.report);
        if (!report?.receipt) revoked = true;
        else { const identity = JSON.stringify(report.receipt); if (firstReceipt === undefined) firstReceipt = identity; else if (identity !== firstReceipt) revoked = true; }
        if (data.role === "planner-span-report") { finalSeen = true; finalReport = report; } else partialReport = report;
      } else revoked = true;
    });
    try { controller.send({ role: "planner-span-controller", origin_ms: performance.timeOrigin }); } catch { cancellation.abort(); }
    const outcome = await pending, observations = received(), report = revoked ? null : observations.final, partial = revoked ? null : observations.partial;
    if (!outcome.closed || outcome.expired || outcome.failed || outcome.exit_code !== 0 || !report || deadline.remaining() <= 0) {
      const unavailable = spanUnavailableReport(deadline, outcome.expired || deadline.remaining() <= 0, partial?.receipt ?? report?.receipt ?? null); unavailable.source_hashes = partial?.source_hashes ?? report?.source_hashes ?? {}; return unavailable;
    }
    report.wall_ms = deadline.elapsed(); return report;
  } catch { const observations = received(), partial = revoked ? null : observations.partial ?? observations.final, unavailable = spanUnavailableReport(deadline, deadline.remaining() <= 0, partial?.receipt ?? null); unavailable.source_hashes = partial?.source_hashes ?? {}; return unavailable; }
}
async function plannerSpanControllerWorker(value: unknown): Promise<void> {
  try {
    const data = plainAggregate(value); if (!data || Object.keys(data).length !== 2 || data.role !== "planner-span-controller" || !finite(data.origin_ms)) throw new Error();
    const origin = data.origin_ms, deadline = new ProfileDeadline(() => performance.timeOrigin + performance.now() - origin);
    const send = (message: unknown) => { if (!process.send || !process.connected) throw new Error(); process.send(message, () => {}); };
    const report = await runLoadedPlannerSpan(deadline, (source) => send(source), (partial) => send({ role: "planner-span-progress", report: partial }));
    if (!process.send) throw new Error(); process.send({ role: "planner-span-report", report }, (error) => { if (process.connected) process.disconnect(); process.exitCode = error ? 1 : 0; });
  } catch { if (process.connected) process.disconnect(); process.exitCode = 1; }
}

// P11 adds prospective fixture observations without changing the earlier contracts.
export const PLANNER_WAIT_CHECKPOINTS = Object.freeze(["callback-start", "attempt-enter", "attempt-return", "attempt-sync-throw", "attempt-resolve", "attempt-reject", "executor-enter", "executor-body-return", "executor-body-throw", "wait-enter", "wait-return", "wait-reject", "capture"] as const);
export type PlannerWaitCheckpoint = typeof PLANNER_WAIT_CHECKPOINTS[number];
type PlannerWaitReason = "invalid-clock" | "invalid-binding" | "invalid-sequence" | "capacity-exhausted" | "callback-not-observed";
export interface PlannerWaitPolls { calls: number; read_returns: number; read_throws: number; first_start_ms: number | null; last_start_ms: number | null; max_start_gap_ms: number | null; read_total_ms: number; read_max_ms: number | null; last_lifecycle: "queued" | "running" | "finished" | "missing" | "unsupported" | null }
interface PlannerWaitCommon { schema_version: 1; kind: "planner-wait-observation"; source: "runner/workflow-orchestrator.test.ts"; alias: "first-implementation-planner"; observation_point: "after-existing-captures-before-worker-stop"; acceptance: false; sealed: true }
export type PlannerWaitReceipt = PlannerWaitCommon & ({ capture_status: "captured"; unavailable_reason: null; observation_elapsed_ms: number; checkpoints: Record<PlannerWaitCheckpoint, number | null>; order: readonly PlannerWaitCheckpoint[]; polls: PlannerWaitPolls } | { capture_status: "unavailable"; unavailable_reason: PlannerWaitReason; observation_elapsed_ms: null; checkpoints: null; order: null; polls: null });
export interface PlannerWaitFixtureBinding { taskId: string; root: string; executor: object; worker: object }
export interface PlannerWaitAttemptBinding extends PlannerWaitFixtureBinding { options: object }
export interface PlannerWaitObserver {
  checkpoint(name: PlannerWaitCheckpoint): void;
  bindFixture(binding: PlannerWaitFixtureBinding): void;
  observeAttempt<T>(binding: PlannerWaitAttemptBinding, invoke: () => T): T;
  beginRead(): { returned(lifecycle: unknown): void; threw(): void };
}
export const PLANNER_WAIT_MARKER = "PLANNER_WAIT_PROFILE ", PLANNER_WAIT_LINE_BYTES = 8192;
const plannerWaitReasons: readonly PlannerWaitReason[] = ["invalid-clock", "invalid-binding", "invalid-sequence", "capacity-exhausted", "callback-not-observed"];
const waitCommon: PlannerWaitCommon = Object.freeze({ schema_version: 1, kind: "planner-wait-observation", source: "runner/workflow-orchestrator.test.ts", alias: "first-implementation-planner", observation_point: "after-existing-captures-before-worker-stop", acceptance: false, sealed: true });
const plannerWaitNativePromise = Promise, plannerWaitPromisePrototype = Promise.prototype, plannerWaitNativeThen = Promise.prototype.then;
const plannerWaitSpeciesGetter = Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get;
function unavailablePlannerWait(reason: PlannerWaitReason): PlannerWaitReceipt { return Object.freeze({ ...waitCommon, capture_status: "unavailable", unavailable_reason: reason, observation_elapsed_ms: null, checkpoints: null, order: null, polls: null }); }
function waitEmptyCheckpoints(): Record<PlannerWaitCheckpoint, number | null> { return Object.fromEntries(PLANNER_WAIT_CHECKPOINTS.map((name) => [name, null])) as Record<PlannerWaitCheckpoint, number | null>; }
function waitCheckpointSequence(checkpoints: Record<PlannerWaitCheckpoint, number | null>, order: readonly PlannerWaitCheckpoint[], captured: boolean): boolean {
  if (!order.length || order[0] !== "callback-start" || checkpoints["callback-start"] !== 0 || captured && order.at(-1) !== "capture" || !captured && checkpoints.capture !== null) return false;
  let previous = 0; const seen = new Set<PlannerWaitCheckpoint>();
  for (const name of order) { const at = checkpoints[name]; if (seen.has(name) || !spanTime(at) || at < previous) return false; seen.add(name); previous = at; }
  if (PLANNER_WAIT_CHECKPOINTS.some((name) => (checkpoints[name] !== null) !== seen.has(name))) return false;
  const before = (first: PlannerWaitCheckpoint, later: PlannerWaitCheckpoint) => checkpoints[later] === null || checkpoints[first] !== null && order.indexOf(first) < order.indexOf(later);
  if (!before("attempt-enter", "attempt-return") || !before("attempt-enter", "attempt-sync-throw") || !before("attempt-return", "attempt-resolve") || !before("attempt-return", "attempt-reject") || !before("attempt-enter", "executor-enter") || !before("executor-enter", "executor-body-return") || !before("executor-enter", "executor-body-throw") || !before("wait-enter", "wait-return") || !before("wait-enter", "wait-reject")) return false;
  if ([["attempt-return", "attempt-sync-throw"], ["attempt-resolve", "attempt-reject"], ["executor-body-return", "executor-body-throw"], ["wait-return", "wait-reject"]].some(([a, b]) => checkpoints[a as PlannerWaitCheckpoint] !== null && checkpoints[b as PlannerWaitCheckpoint] !== null)) return false;
  const settlement = checkpoints["attempt-resolve"] !== null ? "attempt-resolve" : checkpoints["attempt-reject"] !== null ? "attempt-reject" : checkpoints["attempt-sync-throw"] !== null ? "attempt-sync-throw" : null;
  return !settlement || ["executor-enter", "executor-body-return", "executor-body-throw"].every((name) => checkpoints[name as PlannerWaitCheckpoint] === null || order.indexOf(name as PlannerWaitCheckpoint) < order.indexOf(settlement));
}
/** Closed own-data DTO with partial-order validation, never task/error projection. */
export function sanitizePlannerWaitReceipt(value: unknown): PlannerWaitReceipt | null {
  try {
    const data = suiteExact(value, [...Object.keys(waitCommon), "capture_status", "unavailable_reason", "observation_elapsed_ms", "checkpoints", "order", "polls"]);
    if (!data || Object.entries(waitCommon).some(([key, expected]) => data[key] !== expected)) return null;
    if (data.capture_status === "unavailable") return plannerWaitReasons.includes(data.unavailable_reason as PlannerWaitReason) && ["observation_elapsed_ms", "checkpoints", "order", "polls"].every((key) => data[key] === null) ? unavailablePlannerWait(data.unavailable_reason as PlannerWaitReason) : null;
    if (data.capture_status !== "captured" || data.unavailable_reason !== null || !spanTime(data.observation_elapsed_ms)) return null;
    const input = suiteExact(data.checkpoints, PLANNER_WAIT_CHECKPOINTS); if (!input || !suiteArray(data.order, 13)) return null;
    const checkpoints = waitEmptyCheckpoints(), order: PlannerWaitCheckpoint[] = [];
    for (const name of PLANNER_WAIT_CHECKPOINTS) { if (input[name] !== null && !spanTime(input[name])) return null; checkpoints[name] = input[name] as number | null; }
    for (let index = 0; index < data.order.length; index++) { const entry = Object.getOwnPropertyDescriptor(data.order, String(index))!.value as unknown; if (!(PLANNER_WAIT_CHECKPOINTS as readonly unknown[]).includes(entry)) return null; order.push(entry as PlannerWaitCheckpoint); }
    if (!waitCheckpointSequence(checkpoints, order, true) || checkpoints.capture !== data.observation_elapsed_ms) return null;
    const p = suiteExact(data.polls, ["calls", "read_returns", "read_throws", "first_start_ms", "last_start_ms", "max_start_gap_ms", "read_total_ms", "read_max_ms", "last_lifecycle"]);
    if (!p || !suiteInteger(p.calls, 256) || !suiteInteger(p.read_returns, 256) || !suiteInteger(p.read_throws, 256) || p.read_returns + p.read_throws > p.calls || p.calls - p.read_returns - p.read_throws > 1 || !spanTime(p.read_total_ms) || p.read_total_ms > data.observation_elapsed_ms || ![null, "queued", "running", "finished", "missing", "unsupported"].includes(p.last_lifecycle as string | null)) return null;
    if (p.calls === 0) { if (["first_start_ms", "last_start_ms", "max_start_gap_ms", "read_max_ms", "last_lifecycle"].some((key) => p[key] !== null) || p.read_total_ms !== 0 || p.read_returns !== 0 || p.read_throws !== 0) return null; }
    else {
      if (checkpoints["wait-enter"] === null || !spanTime(p.first_start_ms) || !spanTime(p.last_start_ms) || p.first_start_ms < checkpoints["wait-enter"] || p.last_start_ms < p.first_start_ms || p.last_start_ms > data.observation_elapsed_ms || p.calls === 1 && (p.first_start_ms !== p.last_start_ms || p.max_start_gap_ms !== null) || p.calls > 1 && (!spanTime(p.max_start_gap_ms) || p.max_start_gap_ms > p.last_start_ms - p.first_start_ms || p.max_start_gap_ms * (p.calls - 1) < p.last_start_ms - p.first_start_ms)) return null;
      const ended = checkpoints["wait-return"] ?? checkpoints["wait-reject"]; if (ended !== null && (p.last_start_ms > ended || p.calls !== p.read_returns + p.read_throws)) return null;
      if (p.read_returns + p.read_throws === 0 ? p.read_max_ms !== null || p.read_total_ms !== 0 : !spanTime(p.read_max_ms) || p.read_max_ms > p.read_total_ms || p.read_max_ms * (p.read_returns + p.read_throws) < p.read_total_ms) return null;
      if ((p.read_returns === 0) !== (p.last_lifecycle === null)) return null;
    }
    const polls: PlannerWaitPolls = { calls: p.calls, read_returns: p.read_returns, read_throws: p.read_throws, first_start_ms: p.first_start_ms as number | null, last_start_ms: p.last_start_ms as number | null, max_start_gap_ms: p.max_start_gap_ms as number | null, read_total_ms: p.read_total_ms, read_max_ms: p.read_max_ms as number | null, last_lifecycle: p.last_lifecycle as PlannerWaitPolls["last_lifecycle"] };
    return Object.freeze({ ...waitCommon, capture_status: "captured", unavailable_reason: null, observation_elapsed_ms: data.observation_elapsed_ms, checkpoints: Object.freeze(checkpoints), order: Object.freeze(order), polls: Object.freeze(polls) });
  } catch { return null; }
}
interface PlannerWaitCaptureDependencies { env?: NodeJS.ProcessEnv; write?: (line: string) => unknown; clock?: () => number }
/** Privately consumed fixture handle; observer failure cannot replace execution. */
export function createPlannerWaitCapture(dependencies: PlannerWaitCaptureDependencies = {}): { prepare(context: unknown): void; beginCallback(): PlannerWaitObserver | undefined; capture(context: unknown): void } {
  let enabled = false, write: ((line: string) => unknown) | undefined, suppliedClock: (() => number) | undefined;
  try { const input = suiteRecord(dependencies, 3); if (!input || Object.keys(input).some((key) => !["env", "write", "clock"].includes(key)) || input.write !== undefined && (typeof input.write !== "function" || nodeTypes.isProxy(input.write)) || input.clock !== undefined && (typeof input.clock !== "function" || nodeTypes.isProxy(input.clock))) throw new Error(); write = input.write as typeof write; suppliedClock = input.clock as typeof suppliedClock; const env = input.env ?? process.env; if (!env || typeof env !== "object" || nodeTypes.isProxy(env)) throw new Error(); enabled = ["SURTEC_TEST_PLANNER_WAIT_PROFILE", "SURTEC_TEST_SUITE_PROGRESS_PROFILE", "SURTEC_TEST_PLANNER_SPAN_PROFILE"].every((key) => failureOwn(env, key, true).value === "1") && !["SURTEC_TEST_PLANNER_PROFILE", "SURTEC_TEST_PLANNER_FS_PROFILE", "SURTEC_TEST_PLANNER_FAILURE_PROFILE"].some((key) => failureOwn(env, key, true).present); } catch { enabled = false; }
  interface Handle { context: object; consumed: boolean; started: boolean; sealed: boolean; clockReading?: boolean; reason?: PlannerWaitReason; origin?: number; last?: number; checkpoints: Record<PlannerWaitCheckpoint, number | null>; order: PlannerWaitCheckpoint[]; polls: PlannerWaitPolls; reading: boolean; binding?: PlannerWaitFixtureBinding; options?: object; runId?: string; observer: PlannerWaitObserver }
  const handles = new WeakMap<object, Handle>(), clock = suppliedClock ?? performance.now.bind(performance);
  let slot: Handle | undefined, active: Handle | undefined, emitted = false, hasBinding = false;
  const invalid = (handle: Handle, reason: PlannerWaitReason) => { if (!handle.sealed && !handle.reason) handle.reason = reason; };
  const now = (handle: Handle): number | undefined => { if (handle.sealed || handle.reason) return; if (handle.clockReading) { invalid(handle, "invalid-clock"); return; } handle.clockReading = true; try { const current = clock(); if (handle.sealed || handle.reason) return; if (!finite(current) || handle.last !== undefined && current < handle.last || handle.origin !== undefined && !spanTime(current - handle.origin)) { invalid(handle, "invalid-clock"); return; } handle.last = current; handle.origin ??= current; return current - handle.origin; } catch { invalid(handle, "invalid-clock"); return; } finally { handle.clockReading = false; } };
  const checkpoint = (handle: Handle, name: PlannerWaitCheckpoint) => { if (handle.sealed || handle.reason) return; if (!handle.started || handle.checkpoints[name] !== null || !(PLANNER_WAIT_CHECKPOINTS as readonly unknown[]).includes(name)) { invalid(handle, "invalid-sequence"); return; } const at = now(handle); if (at === undefined) return; handle.checkpoints[name] = at; handle.order.push(name); if (!waitCheckpointSequence(handle.checkpoints, handle.order, name === "capture")) invalid(handle, "invalid-sequence"); };
  const readBinding = (value: unknown, attempt = false): (PlannerWaitFixtureBinding & { options?: object }) | null => {
    try { const data = suiteExact(value, attempt ? ["taskId", "root", "executor", "worker", "options"] : ["taskId", "root", "executor", "worker"]); if (!data || !failureString(data.taskId, 192) || !data.taskId || !failureString(data.root, 4096) || !data.root || !data.executor || typeof data.executor !== "object" || nodeTypes.isProxy(data.executor) || !data.worker || typeof data.worker !== "object" || nodeTypes.isProxy(data.worker) || attempt && (!data.options || typeof data.options !== "object" || nodeTypes.isProxy(data.options))) return null; return { taskId: data.taskId, root: data.root, executor: data.executor, worker: data.worker, ...(attempt ? { options: data.options as object } : {}) }; } catch { return null; }
  };
  const noopRead = Object.freeze({ returned: (_lifecycle: unknown) => {}, threw: () => {} });
  const makeHandle = (context: object): Handle => {
    const handle: Handle = { context, consumed: false, started: false, sealed: false, checkpoints: waitEmptyCheckpoints(), order: [], polls: { calls: 0, read_returns: 0, read_throws: 0, first_start_ms: null, last_start_ms: null, max_start_gap_ms: null, read_total_ms: 0, read_max_ms: null, last_lifecycle: null }, reading: false, observer: undefined as unknown as PlannerWaitObserver };
    handle.observer = Object.freeze({
      checkpoint(name: PlannerWaitCheckpoint): void { if (handle.sealed || handle.reason) return; if (!["executor-enter", "executor-body-return", "executor-body-throw", "wait-enter", "wait-return", "wait-reject"].includes(name)) { invalid(handle, "invalid-sequence"); return; } checkpoint(handle, name); },
      bindFixture(binding: PlannerWaitFixtureBinding): void { if (handle.sealed || handle.reason) return; const bound = readBinding(binding); if (!handle.started || handle.binding || !bound) { invalid(handle, "invalid-binding"); return; } handle.binding = Object.freeze(bound); },
      observeAttempt<T>(binding: PlannerWaitAttemptBinding, invoke: () => T): T {
        if (handle.sealed || handle.reason) return invoke();
        let supported = false;
        try { const bound = readBinding(binding, true), expected = handle.binding; const runId = bound ? failureOwn(bound.options, "runId").value : undefined; supported = Boolean(bound && expected && bound.taskId === expected.taskId && bound.root === expected.root && bound.executor === expected.executor && bound.worker === expected.worker && !handle.options && failureString(runId, 192) && runId); if (!supported) invalid(handle, "invalid-binding"); else { handle.options = bound!.options; handle.runId = runId as string; checkpoint(handle, "attempt-enter"); } } catch { invalid(handle, "invalid-binding"); }
        let result: T;
        try { result = invoke(); } catch (error) { if (supported) checkpoint(handle, "attempt-sync-throw"); throw error; }
        if (supported) {
          checkpoint(handle, "attempt-return");
          if (!handle.sealed && !handle.reason) {
            try { const constructor = Object.getOwnPropertyDescriptor(plannerWaitPromisePrototype, "constructor"), species = Object.getOwnPropertyDescriptor(plannerWaitNativePromise, Symbol.species); if (!result || typeof result !== "object" || nodeTypes.isProxy(result) || !nodeTypes.isPromise(result) || Object.getPrototypeOf(result) !== plannerWaitPromisePrototype || Object.hasOwn(result, "constructor") || Object.hasOwn(result, "then") || !constructor || !Object.hasOwn(constructor, "value") || constructor.value !== plannerWaitNativePromise || !species || species.get !== plannerWaitSpeciesGetter || Object.hasOwn(species, "value")) invalid(handle, "invalid-binding"); else Reflect.apply(plannerWaitNativeThen, result, [() => { try { checkpoint(handle, "attempt-resolve"); } catch { /* No observer rejection. */ } }, () => { try { checkpoint(handle, "attempt-reject"); } catch { /* Never inspect a rejection reason. */ } }]); } catch { invalid(handle, "invalid-binding"); }
          }
        }
        return result;
      },
      beginRead(): { returned(lifecycle: unknown): void; threw(): void } {
        if (handle.sealed || handle.reason) return noopRead;
        if (handle.checkpoints["wait-enter"] === null || handle.checkpoints["wait-return"] !== null || handle.checkpoints["wait-reject"] !== null || handle.reading) { invalid(handle, "invalid-sequence"); return noopRead; }
        if (handle.polls.calls >= 256) { invalid(handle, "capacity-exhausted"); return noopRead; }
        const start = now(handle); if (start === undefined) return noopRead;
        const polls = handle.polls; if (polls.last_start_ms !== null) polls.max_start_gap_ms = Math.max(polls.max_start_gap_ms ?? 0, start - polls.last_start_ms); polls.first_start_ms ??= start; polls.last_start_ms = start; polls.calls++; handle.reading = true; let done = false;
        const end = (returned: boolean, lifecycle?: unknown) => { if (handle.sealed || handle.reason) return; if (done || !handle.reading) { invalid(handle, "invalid-sequence"); return; } done = true; const at = now(handle); if (at === undefined) return; handle.reading = false; const elapsed = at - start; polls.read_total_ms += elapsed; polls.read_max_ms = Math.max(polls.read_max_ms ?? 0, elapsed); if (returned) { polls.read_returns++; polls.last_lifecycle = lifecycle === undefined ? "missing" : lifecycle === "queued" || lifecycle === "running" || lifecycle === "finished" ? lifecycle : "unsupported"; } else polls.read_throws++; };
        return Object.freeze({ returned: (lifecycle: unknown) => end(true, lifecycle), threw: () => end(false) });
      },
    });
    return handle;
  };
  return Object.freeze({
    prepare(context: unknown): void { if (!enabled || emitted) return; try { if (slot) invalid(slot, "invalid-binding"); if (active) invalid(active, "invalid-binding"); slot = undefined; active = undefined; const task = spanTask(context); if (!task) return; if (handles.has(task)) { invalid(handles.get(task)!, "invalid-binding"); return; } const handle = makeHandle(context as object); handles.set(task, handle); slot = handle; hasBinding = true; } catch { slot = undefined; } },
    beginCallback(): PlannerWaitObserver | undefined { if (!enabled || emitted) return; const handle = slot; slot = undefined; if (!handle) { if (active) invalid(active, "invalid-binding"); return; } if (handle.consumed || handle.sealed) { invalid(handle, "invalid-binding"); return; } handle.consumed = true; handle.started = true; active = handle; checkpoint(handle, "callback-start"); return handle.observer; },
    capture(context: unknown): void {
      if (!enabled || emitted) return;
      try {
        const task = spanTask(context, false); if (!task) return; const handle = handles.get(task); if (!handle && hasBinding) return;
        let receipt: PlannerWaitReceipt;
        if (!handle) receipt = unavailablePlannerWait("invalid-binding");
        else {
          if (handle.sealed) return;
          if (handle.context !== context || spanTask(context) !== task) invalid(handle, "invalid-binding");
          if (!handle.reason && handle.started) checkpoint(handle, "capture");
          // Seal before projecting: re-entrant or late continuations cannot read the clock.
          handle.sealed = true;
          receipt = handle.reason ? unavailablePlannerWait(handle.reason) : !handle.started ? unavailablePlannerWait("callback-not-observed") : sanitizePlannerWaitReceipt({ ...waitCommon, capture_status: "captured", unavailable_reason: null, observation_elapsed_ms: handle.checkpoints.capture, checkpoints: handle.checkpoints, order: handle.order, polls: handle.polls }) ?? unavailablePlannerWait("invalid-sequence");
        }
        emitted = true; const line = `${PLANNER_WAIT_MARKER}${JSON.stringify(receipt)}\n`;
        if (Buffer.byteLength(line, "utf8") <= PLANNER_WAIT_LINE_BYTES) (write ?? ((text: string) => process.stdout.write(text)))(line);
      } catch { /* One best-effort receipt never changes original execution or cleanup. */ }
    },
  });
}
/** Detaches only complete valid P11 lines; all remaining stdout bytes retain order. */
export function createPlannerWaitMarkerCollector(onReceipt: (receipt: PlannerWaitReceipt | null) => void = () => {}, onData: (chunk: Buffer) => void = () => {}): { push(chunk: Buffer | string): void; finish(): PlannerWaitReceipt | null; valid(): boolean } {
  const prefix = Buffer.from(PLANNER_WAIT_MARKER); let line: number[] = [], streaming = false, reserved = false, markers = 0, total = 0, invalid = false, finished = false, revoked = false, receipt: PlannerWaitReceipt | null = null;
  const revoke = () => { invalid = true; receipt = null; if (!revoked) { revoked = true; try { onReceipt(null); } catch { /* Transport remains invalid. */ } } };
  const forward = (bytes: Buffer) => { if (!bytes.length) return; try { onData(Buffer.from(bytes)); } catch { revoke(); } };
  const processLine = () => {
    const bytes = Buffer.from(line); const exactPrefix = bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix);
    if (exactPrefix) {
      let parsed: PlannerWaitReceipt | null = null;
      if (bytes.length <= PLANNER_WAIT_LINE_BYTES) { try { const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(prefix.length, bytes.length - 1)); parsed = sanitizePlannerWaitReceipt(suiteParseJson(raw)); } catch { /* Invalid reserved lines remain in JSON input. */ } }
      markers++; if (!parsed || markers !== 1 || invalid) { revoke(); forward(bytes); } else { receipt = parsed; try { onReceipt(parsed); } catch { revoke(); forward(bytes); } }
    } else { if (reserved) revoke(); forward(bytes); }
    line = []; streaming = false; reserved = false;
  };
  return Object.freeze({
    push(chunk: Buffer | string): void {
      if (finished) { revoke(); return; }
      if (typeof chunk !== "string" && (!Buffer.isBuffer(chunk) || nodeTypes.isProxy(chunk))) { revoke(); return; }
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk; total += bytes.length; if (total > OUTPUT_LIMIT) { revoke(); return; }
      for (let index = 0; index < bytes.length; index++) {
        const byte = bytes[index]!;
        if (streaming) { const end = bytes.indexOf(10, index); forward(bytes.subarray(index, end < 0 ? bytes.length : end + 1)); if (end < 0) break; index = end; streaming = false; reserved = false; continue; }
        line.push(byte);
        const compared = Math.min(line.length, prefix.length), matching = line.slice(0, compared).every((value, index) => value === prefix[index]);
        if (matching) reserved = true;
        if (byte === 10) { processLine(); continue; }
        if (!matching || line.length >= PLANNER_WAIT_LINE_BYTES) { const reservedStem = line.length >= prefix.length - 1 && Buffer.from(line).subarray(0, prefix.length - 1).equals(prefix.subarray(0, prefix.length - 1)); if (reservedStem || matching) revoke(); forward(Buffer.from(line)); line = []; streaming = true; reserved = false; }
      }
    },
    finish(): PlannerWaitReceipt | null { if (!finished) { finished = true; if (line.length) { if (reserved) revoke(); forward(Buffer.from(line)); line = []; } } return !invalid && markers === 1 ? receipt : null; },
    valid(): boolean { return !invalid; },
  });
}
export function parsePlannerWaitOutput(output: Buffer | string): PlannerWaitReceipt | null { const collector = createPlannerWaitMarkerCollector(); collector.push(output); return collector.finish(); }

// P12 is a separate, fixture-owned observation; historical observers stay closed.
export const PLANNER_CONTINUITY_MARKER = "PLANNER_CONTINUITY_PROFILE ", PLANNER_CONTINUITY_LINE_BYTES = 8192;
export const PLANNER_CONTINUITY_CHECKPOINTS = Object.freeze(["callback-start", "attempt-enter", "attempt-return", "attempt-sync-throw", "attempt-resolve", "attempt-reject", "wait-enter", "wait-return", "wait-reject", "seal"] as const);
export const PLANNER_CONTINUITY_SNAPSHOTS = Object.freeze(["first-poll-entry", "first-poll-exit", "attempt-settle-after-first-poll", "first-bound-release-entry", "first-bound-release-exit", "first-post-settle-reconcile-entry", "first-post-settle-reconcile-exit", "seal"] as const);
export type PlannerContinuityCheckpoint = typeof PLANNER_CONTINUITY_CHECKPOINTS[number];
export type PlannerContinuitySnapshot = typeof PLANNER_CONTINUITY_SNAPSHOTS[number];
type PlannerContinuityReason = "invalid-clock" | "invalid-binding" | "invalid-sequence" | "capacity-exhausted" | "invalid-sampler" | "callback-not-observed";
export interface PlannerContinuityAggregate { entries: number; returned: number; threw: number; open: number; first_start_ms: number | null; last_start_ms: number | null; last_completed_end_ms: number | null; completed_total_ms: number; completed_max_ms: number | null; open_max_age_ms: number | null }
export interface PlannerContinuityInterval { ordinal: number; start_ms: number; end_ms: number; elapsed_ms: number; settlement: "before-settlement" | "after-settlement" | "straddles-settlement" | "settlement-unobserved" }
export type PlannerContinuityMethod = PlannerContinuityAggregate & { top: readonly PlannerContinuityInterval[] };
interface PlannerContinuityCommon { schema_version: 1; kind: "planner-continuity-observation"; source: "runner/workflow-orchestrator.test.ts"; alias: "first-implementation-planner"; observation_point: "after-existing-captures-before-worker-stop"; acceptance: false; sealed: true }
export type PlannerContinuityReceipt = PlannerContinuityCommon & ({ capture_status: "captured"; unavailable_reason: null; observation_elapsed_ms: number; checkpoints: Record<PlannerContinuityCheckpoint, number | null>; order: readonly PlannerContinuityCheckpoint[]; polls: PlannerContinuityAggregate; methods: { release: PlannerContinuityMethod; reconcile: PlannerContinuityMethod }; snapshots: Record<PlannerContinuitySnapshot, { aborted: boolean; fake_timers: boolean | null } | null> } | { capture_status: "unavailable"; unavailable_reason: PlannerContinuityReason; observation_elapsed_ms: null; checkpoints: null; order: null; polls: null; methods: null; snapshots: null });
export interface PlannerContinuityFixtureBinding extends PlannerWaitFixtureBinding { controller: object }
export interface PlannerContinuityAttemptBinding extends PlannerContinuityFixtureBinding { options: object }
export interface PlannerContinuityObserver { bindFixture(binding: PlannerContinuityFixtureBinding): void; checkpoint(name: "wait-enter" | "wait-return" | "wait-reject"): void; observeAttempt<T>(binding: PlannerContinuityAttemptBinding, invoke: () => T): T; observePoll<T>(invoke: () => T): T }
const continuityCommon: PlannerContinuityCommon = Object.freeze({ schema_version: 1, kind: "planner-continuity-observation", source: "runner/workflow-orchestrator.test.ts", alias: "first-implementation-planner", observation_point: "after-existing-captures-before-worker-stop", acceptance: false, sealed: true });
const continuityReasons: readonly PlannerContinuityReason[] = ["invalid-clock", "invalid-binding", "invalid-sequence", "capacity-exhausted", "invalid-sampler", "callback-not-observed"];
const continuityAggregateKeys = ["entries", "returned", "threw", "open", "first_start_ms", "last_start_ms", "last_completed_end_ms", "completed_total_ms", "completed_max_ms", "open_max_age_ms"] as const;
const continuityNativeApply = Reflect.apply, continuitySignalGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
function continuityUnavailable(reason: PlannerContinuityReason): PlannerContinuityReceipt { return Object.freeze({ ...continuityCommon, capture_status: "unavailable", unavailable_reason: reason, observation_elapsed_ms: null, checkpoints: null, order: null, polls: null, methods: null, snapshots: null }); }
function continuityCheckpoints(): Record<PlannerContinuityCheckpoint, number | null> { return Object.fromEntries(PLANNER_CONTINUITY_CHECKPOINTS.map((key) => [key, null])) as Record<PlannerContinuityCheckpoint, number | null>; }
function continuitySnapshots(): Record<PlannerContinuitySnapshot, { aborted: boolean; fake_timers: boolean | null } | null> { return Object.fromEntries(PLANNER_CONTINUITY_SNAPSHOTS.map((key) => [key, null])) as Record<PlannerContinuitySnapshot, { aborted: boolean; fake_timers: boolean | null } | null>; }
function continuityRelation(start: number, end: number, settlement: number | null): PlannerContinuityInterval["settlement"] { return settlement === null ? "settlement-unobserved" : end < settlement ? "before-settlement" : start >= settlement ? "after-settlement" : "straddles-settlement"; }
function continuitySequence(points: Record<PlannerContinuityCheckpoint, number | null>, order: readonly PlannerContinuityCheckpoint[], captured: boolean): boolean {
  if (order[0] !== "callback-start" || points["callback-start"] !== 0 || captured && order.at(-1) !== "seal" || !captured && points.seal !== null) return false;
  let previous = 0; const seen = new Set<PlannerContinuityCheckpoint>();
  for (const name of order) { const at = points[name]; if (seen.has(name) || !spanTime(at) || at < previous) return false; seen.add(name); previous = at; }
  if (PLANNER_CONTINUITY_CHECKPOINTS.some((name) => (points[name] !== null) !== seen.has(name))) return false;
  const before = (first: PlannerContinuityCheckpoint, later: PlannerContinuityCheckpoint) => points[later] === null || points[first] !== null && order.indexOf(first) < order.indexOf(later);
  return before("attempt-enter", "attempt-return") && before("attempt-enter", "attempt-sync-throw") && before("attempt-return", "attempt-resolve") && before("attempt-return", "attempt-reject") && before("wait-enter", "wait-return") && before("wait-enter", "wait-reject") && ![["attempt-return", "attempt-sync-throw"], ["attempt-resolve", "attempt-reject"], ["wait-return", "wait-reject"]].some(([a, b]) => points[a as PlannerContinuityCheckpoint] !== null && points[b as PlannerContinuityCheckpoint] !== null);
}
/** The DTO exposes bounded timing/boolean facts, never method arguments or results. */
export function sanitizePlannerContinuityReceipt(value: unknown): PlannerContinuityReceipt | null {
  try {
    const data = suiteExact(value, [...Object.keys(continuityCommon), "capture_status", "unavailable_reason", "observation_elapsed_ms", "checkpoints", "order", "polls", "methods", "snapshots"]);
    if (!data || Object.entries(continuityCommon).some(([key, expected]) => data[key] !== expected)) return null;
    if (data.capture_status === "unavailable") return continuityReasons.includes(data.unavailable_reason as PlannerContinuityReason) && ["observation_elapsed_ms", "checkpoints", "order", "polls", "methods", "snapshots"].every((key) => data[key] === null) ? continuityUnavailable(data.unavailable_reason as PlannerContinuityReason) : null;
    if (data.capture_status !== "captured" || data.unavailable_reason !== null || !spanTime(data.observation_elapsed_ms)) return null;
    const elapsed = data.observation_elapsed_ms, rawPoints = suiteExact(data.checkpoints, PLANNER_CONTINUITY_CHECKPOINTS); if (!rawPoints || !suiteArray(data.order, PLANNER_CONTINUITY_CHECKPOINTS.length)) return null;
    const checkpoints = continuityCheckpoints(), order: PlannerContinuityCheckpoint[] = [];
    for (const key of PLANNER_CONTINUITY_CHECKPOINTS) { if (rawPoints[key] !== null && !spanTime(rawPoints[key])) return null; checkpoints[key] = rawPoints[key] as number | null; }
    for (let index = 0; index < data.order.length; index++) { const key = Object.getOwnPropertyDescriptor(data.order, String(index))!.value as unknown; if (!(PLANNER_CONTINUITY_CHECKPOINTS as readonly unknown[]).includes(key)) return null; order.push(key as PlannerContinuityCheckpoint); }
    if (!continuitySequence(checkpoints, order, true) || checkpoints.seal !== elapsed) return null;
    const settlement = checkpoints["attempt-resolve"] ?? checkpoints["attempt-reject"] ?? checkpoints["attempt-sync-throw"];
    const aggregate = (value: unknown, maximum: number, top = false): PlannerContinuityAggregate | PlannerContinuityMethod | null => {
      const row = suiteExact(value, top ? [...continuityAggregateKeys, "top"] : continuityAggregateKeys); if (!row || !["entries", "returned", "threw", "open"].every((key) => suiteInteger(row[key], maximum)) || (row.returned as number) + (row.threw as number) + (row.open as number) !== row.entries || !finite(row.completed_total_ms) || row.completed_total_ms < 0 || row.completed_total_ms > maximum * 900000) return null;
      const entries = row.entries as number, ended = (row.returned as number) + (row.threw as number);
      for (const key of ["first_start_ms", "last_start_ms", "last_completed_end_ms", "completed_max_ms", "open_max_age_ms"] as const) if (row[key] !== null && (!spanTime(row[key]) || row[key] > elapsed)) return null;
      if (entries === 0 ? row.first_start_ms !== null || row.last_start_ms !== null : row.first_start_ms === null || row.last_start_ms === null || (row.first_start_ms as number) > (row.last_start_ms as number)) return null;
      if (ended === 0 ? row.last_completed_end_ms !== null || row.completed_max_ms !== null || row.completed_total_ms !== 0 : row.last_completed_end_ms === null || row.completed_max_ms === null || (row.completed_max_ms as number) > row.completed_total_ms || (row.completed_max_ms as number) * ended < row.completed_total_ms || (row.last_completed_end_ms as number) < (row.first_start_ms as number)) return null;
      if (row.open === 0 ? row.open_max_age_ms !== null : row.open_max_age_ms === null || (row.open_max_age_ms as number) > elapsed - (row.first_start_ms as number) || row.open === entries && row.open_max_age_ms !== elapsed - (row.first_start_ms as number)) return null;
      if (entries === 1 && row.first_start_ms !== row.last_start_ms || ended === entries && entries > 0 && (row.last_completed_end_ms as number) < (row.last_start_ms as number)) return null;
      const result: PlannerContinuityAggregate = { entries, returned: row.returned as number, threw: row.threw as number, open: row.open as number, first_start_ms: row.first_start_ms as number | null, last_start_ms: row.last_start_ms as number | null, last_completed_end_ms: row.last_completed_end_ms as number | null, completed_total_ms: row.completed_total_ms, completed_max_ms: row.completed_max_ms as number | null, open_max_age_ms: row.open_max_age_ms as number | null };
      if (!top) return Object.freeze(result);
      if (!suiteArray(row.top, 4) || row.top.length !== Math.min(ended, 4)) return null; const intervals: PlannerContinuityInterval[] = [], ordinals = new Set<number>();
      for (let index = 0; index < row.top.length; index++) {
        const interval = suiteExact(Object.getOwnPropertyDescriptor(row.top, String(index))!.value, ["ordinal", "start_ms", "end_ms", "elapsed_ms", "settlement"]); if (!interval || !suiteInteger(interval.ordinal, maximum, 1) || interval.ordinal > entries || ordinals.has(interval.ordinal) || !spanTime(interval.start_ms) || !spanTime(interval.end_ms) || !spanTime(interval.elapsed_ms) || interval.start_ms < (result.first_start_ms as number) || interval.start_ms > (result.last_start_ms as number) || interval.end_ms > elapsed || interval.end_ms < interval.start_ms || interval.end_ms - interval.start_ms !== interval.elapsed_ms || interval.elapsed_ms > (result.completed_max_ms as number) || interval.end_ms > (result.last_completed_end_ms as number) || interval.settlement !== continuityRelation(interval.start_ms, interval.end_ms, settlement)) return null;
        const previous = intervals.at(-1); if (previous && (previous.elapsed_ms < interval.elapsed_ms || previous.elapsed_ms === interval.elapsed_ms && previous.ordinal >= interval.ordinal)) return null; ordinals.add(interval.ordinal); intervals.push(Object.freeze({ ordinal: interval.ordinal, start_ms: interval.start_ms, end_ms: interval.end_ms, elapsed_ms: interval.elapsed_ms, settlement: interval.settlement as PlannerContinuityInterval["settlement"] }));
      }
      if (intervals.length && intervals[0]!.elapsed_ms !== result.completed_max_ms || intervals.reduce((sum, entry) => sum + entry.elapsed_ms, 0) > result.completed_total_ms || ended <= 4 && intervals.reduce((sum, entry) => sum + entry.elapsed_ms, 0) !== result.completed_total_ms) return null;
      return Object.freeze({ ...result, top: Object.freeze(intervals) });
    };
    const polls = aggregate(data.polls, 256), rawMethods = suiteExact(data.methods, ["release", "reconcile"]); if (!polls || !rawMethods) return null;
    const release = aggregate(rawMethods.release, 128, true) as PlannerContinuityMethod | null, reconcile = aggregate(rawMethods.reconcile, 128, true) as PlannerContinuityMethod | null;
    if (!release || !reconcile || release.entries + reconcile.entries > 128 || polls.open > 1 || polls.completed_total_ms > elapsed || polls.entries && (checkpoints["wait-enter"] === null || polls.first_start_ms! < checkpoints["wait-enter"]!) || polls.open && polls.open_max_age_ms !== elapsed - polls.last_start_ms!) return null;
    const waitEnd = checkpoints["wait-return"] ?? checkpoints["wait-reject"]; if (waitEnd !== null && (polls.open || polls.last_completed_end_ms !== null && polls.last_completed_end_ms > waitEnd)) return null;
    const rawSnapshots = suiteExact(data.snapshots, PLANNER_CONTINUITY_SNAPSHOTS); if (!rawSnapshots) return null; const snapshots = continuitySnapshots();
    for (const key of PLANNER_CONTINUITY_SNAPSHOTS) { if (rawSnapshots[key] === null) continue; const snapshot = suiteExact(rawSnapshots[key], ["aborted", "fake_timers"]); if (!snapshot || typeof snapshot.aborted !== "boolean" || snapshot.fake_timers !== null && typeof snapshot.fake_timers !== "boolean" || !polls.entries && snapshot.fake_timers !== null) return null; snapshots[key] = Object.freeze({ aborted: snapshot.aborted, fake_timers: snapshot.fake_timers as boolean | null }); }
    if (!snapshots.seal || Boolean(snapshots["first-poll-entry"]) !== Boolean(polls.entries) || Boolean(snapshots["first-poll-exit"]) !== Boolean(polls.returned + polls.threw) || snapshots["first-poll-entry"]?.fake_timers === null || polls.entries > 0 && snapshots.seal.fake_timers === null || settlement !== null && polls.entries > 0 && settlement > polls.first_start_ms! && !snapshots["attempt-settle-after-first-poll"] || snapshots["attempt-settle-after-first-poll"] && (settlement === null || !polls.entries || settlement < polls.first_start_ms!) || snapshots["first-bound-release-exit"] && !snapshots["first-bound-release-entry"] || snapshots["first-post-settle-reconcile-exit"] && !snapshots["first-post-settle-reconcile-entry"] || Boolean(snapshots["first-bound-release-entry"]) !== Boolean(release.entries) || snapshots["first-bound-release-entry"] && checkpoints["attempt-enter"] === null || snapshots["first-post-settle-reconcile-entry"] && (!reconcile.entries || settlement === null)) return null;
    const receipt: PlannerContinuityReceipt = Object.freeze({ ...continuityCommon, capture_status: "captured", unavailable_reason: null, observation_elapsed_ms: elapsed, checkpoints: Object.freeze(checkpoints), order: Object.freeze(order), polls, methods: Object.freeze({ release, reconcile }), snapshots: Object.freeze(snapshots) });
    return Buffer.byteLength(`${PLANNER_CONTINUITY_MARKER}${JSON.stringify(receipt)}\n`, "utf8") <= PLANNER_CONTINUITY_LINE_BYTES ? receipt : null;
  } catch { return null; }
}
/** Positive local observation only; this never grants workflow or phase acceptance. */
export function plannerContinuityPassed(value: PlannerContinuityReceipt | null): boolean {
  const receipt = sanitizePlannerContinuityReceipt(value); if (!receipt || receipt.capture_status !== "captured") return false;
  return ["callback-start", "attempt-enter", "attempt-return", "attempt-resolve", "wait-enter", "wait-return", "seal"].every((key) => receipt.checkpoints[key as PlannerContinuityCheckpoint] !== null)
    && ["attempt-sync-throw", "attempt-reject", "wait-reject"].every((key) => receipt.checkpoints[key as PlannerContinuityCheckpoint] === null)
    && receipt.polls.entries > 0 && receipt.polls.open === 0 && receipt.methods.release.entries > 0 && receipt.methods.release.open === 0 && receipt.methods.release.threw === 0 && receipt.methods.reconcile.entries > 0 && receipt.methods.reconcile.open === 0 && receipt.methods.reconcile.threw === 0
    && receipt.snapshots["first-bound-release-entry"] !== null && receipt.snapshots["first-bound-release-exit"] !== null && receipt.snapshots["first-post-settle-reconcile-entry"] !== null && receipt.snapshots["first-post-settle-reconcile-exit"] !== null;
}
interface PlannerContinuityCaptureDependencies { env?: NodeJS.ProcessEnv; write?: (line: string) => unknown; clock?: () => number; timers?: object }
/** Exact original calls survive unavailable observations and late fixture cleanup. */
export function createPlannerContinuityCapture(dependencies: PlannerContinuityCaptureDependencies = {}): { prepare(context: unknown): void; beginCallback(): PlannerContinuityObserver | undefined; capture(context: unknown): void } {
  let enabled = false, write: ((line: string) => unknown) | undefined, suppliedClock: (() => number) | undefined, timers: object | undefined;
  try {
    const input = suiteRecord(dependencies, 4); if (!input || Object.keys(input).some((key) => !["env", "write", "clock", "timers"].includes(key)) || input.write !== undefined && (typeof input.write !== "function" || nodeTypes.isProxy(input.write)) || input.clock !== undefined && (typeof input.clock !== "function" || nodeTypes.isProxy(input.clock))) throw new Error();
    write = input.write as typeof write; suppliedClock = input.clock as typeof suppliedClock; timers = input.timers as object | undefined;
    const env = input.env ?? process.env; if (!env || typeof env !== "object" || nodeTypes.isProxy(env)) throw new Error();
    enabled = ["SURTEC_TEST_PLANNER_CONTINUITY_PROFILE", "SURTEC_TEST_PLANNER_WAIT_PROFILE", "SURTEC_TEST_SUITE_PROGRESS_PROFILE", "SURTEC_TEST_PLANNER_SPAN_PROFILE"].every((key) => failureOwn(env, key, true).value === "1") && !["SURTEC_TEST_PLANNER_PROFILE", "SURTEC_TEST_PLANNER_FS_PROFILE", "SURTEC_TEST_PLANNER_FAILURE_PROFILE"].some((key) => failureOwn(env, key, true).present);
  } catch { enabled = false; }
  interface Invocation { ordinal: number; start: number; end: number | null; outcome: "returned" | "threw" | null }
  interface InstalledMethod { name: "release" | "reconcile"; original?: PropertyDescriptor; enumerable: boolean; wrapper: (...args: unknown[]) => unknown }
  interface Handle { context: object; consumed: boolean; started: boolean; sealed: boolean; reason?: PlannerContinuityReason; origin?: number; last?: number; clockReading: boolean; sampling: boolean; signal?: object; timerMethod?: (...args: never[]) => unknown; firstPoll: boolean; points: Record<PlannerContinuityCheckpoint, number | null>; order: PlannerContinuityCheckpoint[]; snapshots: ReturnType<typeof continuitySnapshots>; polls: Invocation[]; methods: { release: Invocation[]; reconcile: Invocation[] }; stack: Invocation[]; binding?: PlannerContinuityFixtureBinding; installed?: InstalledMethod[]; options?: object; proof?: object; observer: PlannerContinuityObserver }
  const handles = new WeakMap<object, Handle>(), clock = suppliedClock ?? performance.now.bind(performance); let slot: Handle | undefined, active: Handle | undefined, hasBinding = false, emitted = false;
  const invalid = (handle: Handle, reason: PlannerContinuityReason) => { if (!handle.sealed && !handle.reason) handle.reason = reason; };
  const now = (handle: Handle): number | undefined => {
    if (handle.sealed || handle.reason) return; if (handle.clockReading) { invalid(handle, "invalid-clock"); return; } if (handle.sampling) { invalid(handle, "invalid-sampler"); return; }
    handle.clockReading = true; try { const current = clock(); if (handle.sealed || handle.reason) return; if (!finite(current) || handle.last !== undefined && current < handle.last || handle.origin !== undefined && !spanTime(current - handle.origin)) { invalid(handle, "invalid-clock"); return; } handle.last = current; handle.origin ??= current; return current - handle.origin; } catch { invalid(handle, "invalid-clock"); return; } finally { handle.clockReading = false; }
  };
  const checkpoint = (handle: Handle, name: PlannerContinuityCheckpoint) => { if (handle.sealed || handle.reason) return; if (!handle.started || handle.points[name] !== null || !(PLANNER_CONTINUITY_CHECKPOINTS as readonly unknown[]).includes(name)) { invalid(handle, "invalid-sequence"); return; } const at = now(handle); if (at === undefined) return; handle.points[name] = at; handle.order.push(name); if (!continuitySequence(handle.points, handle.order, name === "seal")) invalid(handle, "invalid-sequence"); };
  const sample = (handle: Handle, name: PlannerContinuitySnapshot) => {
    if (handle.sealed || handle.reason || handle.snapshots[name] !== null) return; if (handle.sampling || handle.clockReading) { invalid(handle, "invalid-sampler"); return; } handle.sampling = true;
    try { if (!handle.signal || !continuitySignalGetter) throw new Error(); const aborted: unknown = continuityNativeApply(continuitySignalGetter, handle.signal, []); let fake: unknown = null; if (handle.firstPoll) { const descriptor = timers && !nodeTypes.isProxy(timers) ? Object.getOwnPropertyDescriptor(timers, "isFakeTimers") : undefined; if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.value !== handle.timerMethod || typeof descriptor.value !== "function" || nodeTypes.isProxy(descriptor.value)) throw new Error(); fake = continuityNativeApply(handle.timerMethod!, timers, []); } if (handle.sealed || handle.reason) return; if (typeof aborted !== "boolean" || fake !== null && typeof fake !== "boolean") throw new Error(); handle.snapshots[name] = { aborted, fake_timers: fake as boolean | null }; } catch { invalid(handle, "invalid-sampler"); } finally { handle.sampling = false; }
  };
  const readBinding = (value: unknown, attempt = false): PlannerContinuityAttemptBinding | PlannerContinuityFixtureBinding | null => {
    try { const input = suiteExact(value, attempt ? ["taskId", "root", "executor", "worker", "controller", "options"] : ["taskId", "root", "executor", "worker", "controller"]); if (!input || !failureString(input.taskId, 192) || !input.taskId || !failureString(input.root, 4096) || !input.root || ["executor", "worker", "controller", ...(attempt ? ["options"] : [])].some((key) => !input[key] || typeof input[key] !== "object" || nodeTypes.isProxy(input[key]))) return null; return { taskId: input.taskId, root: input.root, executor: input.executor as object, worker: input.worker as object, controller: input.controller as object, ...(attempt ? { options: input.options as object } : {}) } as PlannerContinuityAttemptBinding | PlannerContinuityFixtureBinding; } catch { return null; }
  };
  const begin = (handle: Handle, rows: Invocation[], maximum: number): Invocation | undefined => { if (handle.sealed || handle.reason) return; if (rows.length >= maximum) { invalid(handle, "capacity-exhausted"); return; } const at = now(handle); if (at === undefined) return; const row: Invocation = { ordinal: rows.length + 1, start: at, end: null, outcome: null }; rows.push(row); return row; };
  const end = (handle: Handle, row: Invocation | undefined, outcome: "returned" | "threw") => { if (!row || handle.sealed || handle.reason) return; if (row.end !== null) { invalid(handle, "invalid-sequence"); return; } const at = now(handle); if (at === undefined) return; row.end = at; row.outcome = outcome; };
  const install = (handle: Handle) => {
    const controller = handle.binding!.controller, installed: InstalledMethod[] = [];
    try {
      for (const name of ["release", "reconcile"] as const) {
        let owner: object | null = controller, descriptor: PropertyDescriptor | undefined, depth = 0;
        while (owner && owner !== Object.prototype && depth++ < 4) { if (nodeTypes.isProxy(owner)) throw new Error(); descriptor = Object.getOwnPropertyDescriptor(owner, name); if (descriptor) break; owner = Object.getPrototypeOf(owner); }
        if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function" || nodeTypes.isProxy(descriptor.value) || descriptor.writable !== true || descriptor.configurable !== true || !Object.isExtensible(controller)) throw new Error();
        const original = descriptor.value as (...args: unknown[]) => unknown, own = Object.getOwnPropertyDescriptor(controller, name), enumerable = descriptor.enumerable ?? false;
        const wrapper = function(this: unknown, ...args: unknown[]): unknown {
          if (handle.sealed || handle.reason) return continuityNativeApply(original, this, args);
          let row: Invocation | undefined, sampledEntry: PlannerContinuitySnapshot | undefined, sampledExit: PlannerContinuitySnapshot | undefined;
          try {
            const current = Object.getOwnPropertyDescriptor(controller, name); if (this !== controller || !current || !Object.hasOwn(current, "value") || current.value !== wrapper || current.configurable !== true || current.writable !== true || current.enumerable !== enumerable) invalid(handle, "invalid-binding");
            if (name === "release" && (!handle.proof || args[0] !== handle.proof)) invalid(handle, "invalid-binding");
            if (!handle.reason && handle.methods.release.length + handle.methods.reconcile.length >= 128) invalid(handle, "capacity-exhausted");
            row = begin(handle, handle.methods[name], 128); if (row) { handle.stack.push(row); if (name === "release" && !handle.snapshots["first-bound-release-entry"]) { sampledEntry = "first-bound-release-entry"; sampledExit = "first-bound-release-exit"; } else if (name === "reconcile" && (handle.points["attempt-resolve"] !== null || handle.points["attempt-reject"] !== null || handle.points["attempt-sync-throw"] !== null) && !handle.snapshots["first-post-settle-reconcile-entry"]) { sampledEntry = "first-post-settle-reconcile-entry"; sampledExit = "first-post-settle-reconcile-exit"; } if (sampledEntry) sample(handle, sampledEntry); }
          } catch { invalid(handle, "invalid-binding"); }
          let returned = false; try { const result: unknown = continuityNativeApply(original, this, args); returned = true; return result; }
          finally { if (!handle.sealed && !handle.reason && row) { try { if (handle.stack.at(-1) !== row) invalid(handle, "invalid-sequence"); else { handle.stack.pop(); end(handle, row, returned ? "returned" : "threw"); if (sampledExit) sample(handle, sampledExit); } } catch { invalid(handle, "invalid-sequence"); } } }
        };
        Object.defineProperty(controller, name, { value: wrapper, writable: true, configurable: true, enumerable }); installed.push({ name, original: own, enumerable, wrapper });
      }
      handle.installed = installed;
    } catch {
      invalid(handle, "invalid-binding"); for (const entry of installed.reverse()) { try { const current = Object.getOwnPropertyDescriptor(controller, entry.name); if (current && Object.hasOwn(current, "value") && current.value === entry.wrapper && current.configurable === true && current.writable === true && current.enumerable === entry.enumerable) { if (entry.original) Object.defineProperty(controller, entry.name, entry.original); else Reflect.deleteProperty(controller, entry.name); } } catch { /* Never replace a foreign descriptor during failed installation. */ } }
    }
  };
  const project = (rows: Invocation[], elapsed: number, settlement: number | null, method = false): PlannerContinuityAggregate | PlannerContinuityMethod => {
    const completed = rows.filter((row) => row.end !== null), open = rows.filter((row) => row.end === null), durations = completed.map((row) => row.end! - row.start);
    const aggregate: PlannerContinuityAggregate = { entries: rows.length, returned: completed.filter((row) => row.outcome === "returned").length, threw: completed.filter((row) => row.outcome === "threw").length, open: open.length, first_start_ms: rows[0]?.start ?? null, last_start_ms: rows.at(-1)?.start ?? null, last_completed_end_ms: completed.length ? Math.max(...completed.map((row) => row.end!)) : null, completed_total_ms: durations.reduce((sum, duration) => sum + duration, 0), completed_max_ms: durations.length ? Math.max(...durations) : null, open_max_age_ms: open.length ? Math.max(...open.map((row) => elapsed - row.start)) : null };
    return method ? { ...aggregate, top: completed.map((row) => ({ ordinal: row.ordinal, start_ms: row.start, end_ms: row.end!, elapsed_ms: row.end! - row.start, settlement: continuityRelation(row.start, row.end!, settlement) })).sort((a, b) => b.elapsed_ms - a.elapsed_ms || a.ordinal - b.ordinal).slice(0, 4) } : aggregate;
  };
  const makeHandle = (context: object): Handle => {
    const handle: Handle = { context, consumed: false, started: false, sealed: false, clockReading: false, sampling: false, firstPoll: false, points: continuityCheckpoints(), order: [], snapshots: continuitySnapshots(), polls: [], methods: { release: [], reconcile: [] }, stack: [], observer: undefined as unknown as PlannerContinuityObserver };
    try { const signal = failureOwn(context, "signal", true); if (!signal.present || !signal.value || typeof signal.value !== "object" || nodeTypes.isProxy(signal.value) || !continuitySignalGetter) throw new Error(); handle.signal = signal.value; if (!timers || typeof timers !== "object" || nodeTypes.isProxy(timers)) throw new Error(); const descriptor = Object.getOwnPropertyDescriptor(timers, "isFakeTimers"); if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function" || nodeTypes.isProxy(descriptor.value)) throw new Error(); handle.timerMethod = descriptor.value; } catch { invalid(handle, "invalid-sampler"); }
    handle.observer = Object.freeze({
      bindFixture(binding: PlannerContinuityFixtureBinding): void { if (handle.sealed || handle.reason) return; const bound = readBinding(binding); if (!handle.started || handle.binding || !bound) { invalid(handle, "invalid-binding"); return; } handle.binding = Object.freeze(bound); install(handle); },
      checkpoint(name: "wait-enter" | "wait-return" | "wait-reject"): void { if (handle.sealed || handle.reason) return; if (!["wait-enter", "wait-return", "wait-reject"].includes(name)) { invalid(handle, "invalid-sequence"); return; } checkpoint(handle, name); },
      observeAttempt<T>(binding: PlannerContinuityAttemptBinding, invoke: () => T): T {
        if (handle.sealed || handle.reason) return invoke(); let supported = false;
        try { const bound = readBinding(binding, true) as PlannerContinuityAttemptBinding | null, expected = handle.binding, runId = bound ? failureOwn(bound.options, "runId").value : undefined, proof = bound ? failureOwn(bound.options, "workflowExecution").value : undefined; supported = Boolean(bound && expected && ["taskId", "root", "executor", "worker", "controller"].every((key) => bound[key as keyof PlannerContinuityFixtureBinding] === expected[key as keyof PlannerContinuityFixtureBinding]) && !handle.options && failureString(runId, 192) && runId && proof && typeof proof === "object" && !nodeTypes.isProxy(proof)); if (!supported) invalid(handle, "invalid-binding"); else { handle.options = bound!.options; handle.proof = proof as object; checkpoint(handle, "attempt-enter"); } } catch { invalid(handle, "invalid-binding"); }
        let result: T; try { result = invoke(); } catch (error) { if (supported) { checkpoint(handle, "attempt-sync-throw"); if (handle.firstPoll) sample(handle, "attempt-settle-after-first-poll"); } throw error; }
        if (supported) { checkpoint(handle, "attempt-return"); if (!handle.sealed && !handle.reason) { try { const constructor = Object.getOwnPropertyDescriptor(plannerWaitPromisePrototype, "constructor"), species = Object.getOwnPropertyDescriptor(plannerWaitNativePromise, Symbol.species); if (!result || typeof result !== "object" || nodeTypes.isProxy(result) || !nodeTypes.isPromise(result) || Object.getPrototypeOf(result) !== plannerWaitPromisePrototype || Object.hasOwn(result, "constructor") || Object.hasOwn(result, "then") || !constructor || !Object.hasOwn(constructor, "value") || constructor.value !== plannerWaitNativePromise || !species || species.get !== plannerWaitSpeciesGetter || Object.hasOwn(species, "value")) invalid(handle, "invalid-binding"); else continuityNativeApply(plannerWaitNativeThen, result, [() => { try { checkpoint(handle, "attempt-resolve"); if (handle.firstPoll) sample(handle, "attempt-settle-after-first-poll"); } catch { /* Observer reactions never reject. */ } }, () => { try { checkpoint(handle, "attempt-reject"); if (handle.firstPoll) sample(handle, "attempt-settle-after-first-poll"); } catch { /* Rejection values remain private. */ } }]); } catch { invalid(handle, "invalid-binding"); } } }
        return result;
      },
      observePoll<T>(invoke: () => T): T {
        if (handle.sealed || handle.reason) return invoke(); if (handle.points["wait-enter"] === null || handle.points["wait-return"] !== null || handle.points["wait-reject"] !== null || handle.polls.some((row) => row.end === null)) invalid(handle, "invalid-sequence");
        const row = begin(handle, handle.polls, 256), first = Boolean(row && !handle.firstPoll); if (first) { handle.firstPoll = true; sample(handle, "first-poll-entry"); }
        let returned = false; try { const result = invoke(); returned = true; return result; } finally { end(handle, row, returned ? "returned" : "threw"); if (first) sample(handle, "first-poll-exit"); }
      },
    }); return handle;
  };
  return Object.freeze({
    prepare(context: unknown): void { if (!enabled || emitted) return; try { if (slot) invalid(slot, "invalid-binding"); if (active) invalid(active, "invalid-binding"); slot = undefined; active = undefined; const task = spanTask(context); if (!task) return; if (handles.has(task)) { invalid(handles.get(task)!, "invalid-binding"); return; } const handle = makeHandle(context as object); handles.set(task, handle); slot = handle; hasBinding = true; } catch { slot = undefined; } },
    beginCallback(): PlannerContinuityObserver | undefined { if (!enabled || emitted) return; const handle = slot; slot = undefined; if (!handle) { if (active) invalid(active, "invalid-binding"); return; } if (handle.consumed || handle.sealed) { invalid(handle, "invalid-binding"); return; } handle.consumed = true; handle.started = true; active = handle; checkpoint(handle, "callback-start"); return handle.observer; },
    capture(context: unknown): void {
      if (!enabled || emitted) return; try { const task = spanTask(context, false); if (!task) return; const handle = handles.get(task); if (!handle && hasBinding) return; let receipt: PlannerContinuityReceipt;
        if (!handle) receipt = continuityUnavailable("invalid-binding"); else { if (handle.sealed) return; if (handle.context !== context || spanTask(context) !== task) invalid(handle, "invalid-binding"); if (!handle.reason && handle.binding) { for (const method of handle.installed ?? []) { const descriptor = Object.getOwnPropertyDescriptor(handle.binding.controller, method.name); if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.value !== method.wrapper || descriptor.configurable !== true || descriptor.writable !== true || descriptor.enumerable !== method.enumerable) invalid(handle, "invalid-binding"); } } if (!handle.reason && handle.started) { checkpoint(handle, "seal"); sample(handle, "seal"); } handle.sealed = true;
          if (handle.reason) receipt = continuityUnavailable(handle.reason); else if (!handle.started) receipt = continuityUnavailable("callback-not-observed"); else { const elapsed = handle.points.seal!, settlement = handle.points["attempt-resolve"] ?? handle.points["attempt-reject"] ?? handle.points["attempt-sync-throw"]; receipt = sanitizePlannerContinuityReceipt({ ...continuityCommon, capture_status: "captured", unavailable_reason: null, observation_elapsed_ms: elapsed, checkpoints: handle.points, order: handle.order, polls: project(handle.polls, elapsed, settlement), methods: { release: project(handle.methods.release, elapsed, settlement, true), reconcile: project(handle.methods.reconcile, elapsed, settlement, true) }, snapshots: handle.snapshots }) ?? continuityUnavailable("invalid-sequence"); }
        }
        emitted = true; const line = `${PLANNER_CONTINUITY_MARKER}${JSON.stringify(receipt)}\n`; if (Buffer.byteLength(line, "utf8") <= PLANNER_CONTINUITY_LINE_BYTES) (write ?? ((text: string) => process.stdout.write(text)))(line);
      } catch { /* One sealed best-effort line cannot replace original cleanup. */ }
    },
  });
}

// P10 uses a separate observation contract. Historical P05-P09 projections stay closed.
export const SUITE_PROGRESS_LIMITS = Object.freeze({ frame_bytes: 2048, frames: 50000, stderr_bytes: 8 * 1024 * 1024, modules: 256, cases: 20000, open_cases: 64, tail: 32, snapshot_bytes: 128 * 1024 });
const SUITE_PROGRESS_MARKER = "SUITE_PROGRESS_PROFILE ";
type SuiteProgressState = "passed" | "failed" | "skipped";
type SuiteProgressAttempt = "zero" | "nonzero" | "unavailable";
type SuiteProgressReason = "invalid-clock" | "invalid-binding" | "invalid-sequence" | "capacity-exhausted";
interface SuiteProgressModule { ordinal: number; source: string }
interface SuiteProgressCase { ordinal: number; alias: "first-implementation-planner" | null }
interface SuiteProgressFrameCommon { schema_version: 1; kind: "suite-progress-observation"; sequence: number; reporter_elapsed_ms: number | null; module: SuiteProgressModule | null; case: SuiteProgressCase | null }
export type SuiteProgressFrame = SuiteProgressFrameCommon & (
  { event: "reporter-init" | "module-queued" | "module-start" | "case-ready"; data: null } |
  { event: "run-start"; data: { module_count: number } } |
  { event: "module-collected"; data: { case_count: number } } |
  { event: "case-result"; data: { state: SuiteProgressState; original_attempt: SuiteProgressAttempt | null } } |
  { event: "module-end"; data: { state: SuiteProgressState } } |
  { event: "run-end"; data: { reason: "passed" | "failed" | "interrupted"; unhandled_errors: number } } |
  { event: "observer-unavailable"; data: { reason: SuiteProgressReason } }
);
interface SuiteProgressCounts { collected: number; ready: number; finished: number; passed: number; failed: number; skipped: number }
interface SuiteProgressModuleSnapshot extends SuiteProgressModule { queued: boolean; collected: boolean; started: boolean; ended: boolean; state: SuiteProgressState | null; counts: SuiteProgressCounts }
export interface SuiteProgressSnapshot {
  schema_version: 1; availability: "available" | "unavailable"; unavailable_reason: SuiteProgressReason | "invalid-transport" | null;
  sequence: number; reporter_elapsed_ms: number | null; module_count: number | null; modules: SuiteProgressModuleSnapshot[]; counts: SuiteProgressCounts;
  open_cases: Array<{ module: number; case: number }>; tail: SuiteProgressFrame[];
  run_end: { reason: "passed" | "failed" | "interrupted"; unhandled_errors: number } | null;
  planner_result: { module: number; case: number; state: SuiteProgressState; original_attempt: SuiteProgressAttempt } | null;
}
const suiteReasons = ["invalid-clock", "invalid-binding", "invalid-sequence", "capacity-exhausted"] as const;
const suiteStates = ["passed", "failed", "skipped"] as const;
const suiteAttempts = ["zero", "nonzero", "unavailable"] as const;
const suiteCountFields = ["collected", "ready", "finished", "passed", "failed", "skipped"] as const;
function suiteInteger(value: unknown, maximum: number, minimum = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum; }
function suiteRecord(value: unknown, maximum: number): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return null;
  const keys = Reflect.ownKeys(value); if (keys.length > maximum) return null; const result: Record<string, unknown> = {};
  for (const key of keys) { if (typeof key !== "string") return null; const descriptor = Object.getOwnPropertyDescriptor(value, key)!; if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return null; Object.defineProperty(result, key, { value: descriptor.value, enumerable: true }); } return result;
}
function suiteExact(value: unknown, keys: readonly string[]): Record<string, unknown> | null { const data = suiteRecord(value, keys.length); return data && Object.keys(data).length === keys.length && keys.every((key) => Object.hasOwn(data, key)) ? data : null; }
function suiteSource(value: unknown): value is string { return typeof value === "string" && value.length <= 192 && /^[\x21-\x7e]+$/.test(value) && /^(cli|dashboard|lib|runner|scripts)\/(?:[^/]+\/)*[^/]+\.test\.tsx?$/.test(value) && !/["\\?#:%]/.test(value) && value.split("/").every((part) => part !== "." && part !== ".." && part.length > 0); }
function suiteRelative(value: unknown): string | null {
  if (typeof value !== "string" || value.length > repository.length + 194 || /[\0?#]/.test(value)) return null;
  const path = value.replace(/\\/g, "/"), root = repository.replace(/\\/g, "/") + "/";
  const source = path.startsWith(root) ? path.slice(root.length) : path;
  return suiteSource(source) ? source : null;
}
function suiteModule(value: unknown): SuiteProgressModule | null { const data = suiteExact(value, ["ordinal", "source"]); return data && suiteInteger(data.ordinal, 256, 1) && suiteSource(data.source) ? { ordinal: data.ordinal, source: data.source } : null; }
function suiteCase(value: unknown): SuiteProgressCase | null { const data = suiteExact(value, ["ordinal", "alias"]); return data && suiteInteger(data.ordinal, 20000, 1) && (data.alias === null || data.alias === "first-implementation-planner") ? { ordinal: data.ordinal, alias: data.alias } : null; }
/** Closed, detached public frame. No result payload, name or error is copied. */
export function sanitizeSuiteProgressFrame(value: unknown): SuiteProgressFrame | null {
  try {
    const data = suiteExact(value, ["schema_version", "kind", "sequence", "event", "reporter_elapsed_ms", "module", "case", "data"]);
    if (!data || data.schema_version !== 1 || data.kind !== "suite-progress-observation" || !suiteInteger(data.sequence, 50000, 1)) return null;
    const module = data.module === null ? null : suiteModule(data.module), test = data.case === null ? null : suiteCase(data.case);
    if (data.module !== null && !module || data.case !== null && !test) return null;
    if (test?.alias && module?.source !== "runner/workflow-orchestrator.test.ts") return null;
    if (data.event === "observer-unavailable") {
      const reason = suiteExact(data.data, ["reason"]); if (module || test || data.reporter_elapsed_ms !== null || !reason || !(suiteReasons as readonly unknown[]).includes(reason.reason)) return null;
      return { schema_version: 1, kind: "suite-progress-observation", sequence: data.sequence, event: "observer-unavailable", reporter_elapsed_ms: null, module: null, case: null, data: { reason: reason.reason as SuiteProgressReason } };
    }
    if (!spanTime(data.reporter_elapsed_ms)) return null;
    const base = { schema_version: 1 as const, kind: "suite-progress-observation" as const, sequence: data.sequence, reporter_elapsed_ms: data.reporter_elapsed_ms, module, case: test };
    if (data.event === "reporter-init" && !module && !test && data.data === null) return { ...base, event: data.event, data: null };
    if (data.event === "run-start") { const next = suiteExact(data.data, ["module_count"]); if (!module && !test && next && suiteInteger(next.module_count, 256)) return { ...base, event: data.event, data: { module_count: next.module_count } }; }
    if (["module-queued", "module-start"].includes(data.event as string) && module && !test && data.data === null) return { ...base, event: data.event as "module-queued" | "module-start", data: null };
    if (data.event === "module-collected") { const next = suiteExact(data.data, ["case_count"]); if (module && !test && next && suiteInteger(next.case_count, 20000)) return { ...base, event: data.event, data: { case_count: next.case_count } }; }
    if (data.event === "case-ready" && module && test && data.data === null) return { ...base, event: data.event, data: null };
    if (data.event === "case-result") { const next = suiteExact(data.data, ["state", "original_attempt"]); if (module && test && next && (suiteStates as readonly unknown[]).includes(next.state) && (test.alias === null ? next.original_attempt === null : (suiteAttempts as readonly unknown[]).includes(next.original_attempt))) return { ...base, event: data.event, data: { state: next.state as SuiteProgressState, original_attempt: next.original_attempt as SuiteProgressAttempt | null } }; }
    if (data.event === "module-end") { const next = suiteExact(data.data, ["state"]); if (module && !test && next && (suiteStates as readonly unknown[]).includes(next.state)) return { ...base, event: data.event, data: { state: next.state as SuiteProgressState } }; }
    if (data.event === "run-end") { const next = suiteExact(data.data, ["reason", "unhandled_errors"]); if (!module && !test && next && ["passed", "failed", "interrupted"].includes(next.reason as string) && suiteInteger(next.unhandled_errors, 20000)) return { ...base, event: data.event, data: { reason: next.reason as "passed" | "failed" | "interrupted", unhandled_errors: next.unhandled_errors } }; }
    return null;
  } catch { return null; }
}
interface SuiteReporterModule { moduleId: string; project: object; toTestSpecification(): { moduleId: string; project: object; pool: unknown }; children: { allTests(): Iterable<SuiteReporterCase> }; state(): string }
interface SuiteReporterCase { module: SuiteReporterModule; name: string; result(): { state: string }; diagnostic(): { retryCount: number; repeatCount: number } | undefined }
interface SuiteReporterSpecification { moduleId: string; project: object; pool: unknown }
interface SuiteProgressReporterDependencies { env?: NodeJS.ProcessEnv; clock?: () => number; write?: (line: string) => unknown }
function suitePublic(value: unknown, key: string): unknown {
  let current = value;
  for (let depth = 0; depth < 8 && current !== null; depth++) {
    if (!current || typeof current !== "object" || nodeTypes.isProxy(current)) throw new Error();
    const descriptor = Object.getOwnPropertyDescriptor(current, key); if (descriptor) { if (!Object.hasOwn(descriptor, "value")) throw new Error(); return descriptor.value; } current = Object.getPrototypeOf(current);
  } throw new Error();
}
function suiteCall(value: unknown, key: string): unknown { const method = suitePublic(value, key); if (typeof method !== "function" || nodeTypes.isProxy(method)) throw new Error(); return Reflect.apply(method, value, []); }
/** Synchronous public Vitest lifecycle observer; constructing/importing never launches work. */
export function createSuiteProgressReporter(dependencies: SuiteProgressReporterDependencies = {}) {
  let enabled = false;
  try { const env = dependencies.env ?? process.env; enabled = failureOwn(env, "SURTEC_TEST_SUITE_PROGRESS_PROFILE", true).value === "1" && failureOwn(env, "SURTEC_TEST_PLANNER_SPAN_PROFILE", true).value === "1" && ["SURTEC_TEST_PLANNER_PROFILE", "SURTEC_TEST_PLANNER_FS_PROFILE", "SURTEC_TEST_PLANNER_FAILURE_PROFILE"].every((key) => !failureOwn(env, key, true).present); } catch { enabled = false; }
  let partialEnabled = false;
  try { const env = dependencies.env ?? process.env; partialEnabled = enabled && ["SURTEC_TEST_PLANNER_WAIT_PROFILE", "SURTEC_TEST_PLANNER_CONTINUITY_PROFILE"].every((key) => failureOwn(env, key, true).value === "1"); } catch { /* Independent side observation remains disabled. */ }
  const clock = dependencies.clock ?? (() => performance.now()), write = dependencies.write ?? ((line: string) => process.stderr.write(line));
  interface Binding { public: SuiteProgressModule; specification: SuiteReporterSpecification; object?: SuiteReporterModule; replaced: boolean; queued: boolean; collected: boolean; started: boolean; ended: boolean; cases?: SuiteReporterCase[] }
  interface CaseBinding { module: Binding; public: SuiteProgressCase; ready: boolean; finished: boolean }
  const modules = new Map<string, Binding>(), cases = new Map<SuiteReporterCase, CaseBinding>(), open = new Set<CaseBinding>();
  let stopped = false, sequence = 0, bytes = 0, origin: number | undefined, last: number | undefined, initialized = false, started = false, ended = false, planners = 0;
  let partialFailures = 0, partialModule = false;
  const sample = (value: P16Sample): void => { try { const safe = p16Sample(value); if (!safe) return; const line = `${P16_SAMPLE_MARKER}${JSON.stringify(safe)}\n`; if (Buffer.byteLength(line) <= 2048) write(line); } catch { /* Claimed side slot is never retried and cannot poison original progress. */ } };
  const unavailable = (reason: SuiteProgressReason): void => {
    if (!enabled || stopped) return; stopped = true;
    const frame: SuiteProgressFrame = { schema_version: 1, kind: "suite-progress-observation", sequence: ++sequence, event: "observer-unavailable", reporter_elapsed_ms: null, module: null, case: null, data: { reason } };
    const line = `${SUITE_PROGRESS_MARKER}${JSON.stringify(frame)}\n`; if (sequence <= 50000 && bytes + Buffer.byteLength(line) <= SUITE_PROGRESS_LIMITS.stderr_bytes) try { write(line); } catch { /* A failed native write is never retried. */ }
  };
  const emit = (event: SuiteProgressFrame["event"], module: SuiteProgressModule | null, test: SuiteProgressCase | null, data: SuiteProgressFrame["data"]): void => {
    if (!enabled || stopped) return;
    let now: number; try { now = event === "reporter-init" && origin !== undefined ? origin : clock(); } catch { unavailable("invalid-clock"); return; }
    if (!finite(now) || origin === undefined || last !== undefined && now < last || now - origin > PROFILE_LIMIT_MS) { unavailable("invalid-clock"); return; } last = now;
    const frame = sanitizeSuiteProgressFrame({ schema_version: 1, kind: "suite-progress-observation", sequence: sequence + 1, event, reporter_elapsed_ms: now - origin, module, case: test, data });
    if (!frame) { unavailable("invalid-binding"); return; }
    const line = `${SUITE_PROGRESS_MARKER}${JSON.stringify(frame)}\n`, size = Buffer.byteLength(line);
    if (sequence >= 49999 || size > 2048 || bytes + size > SUITE_PROGRESS_LIMITS.stderr_bytes - 2048) { unavailable("capacity-exhausted"); return; }
    sequence++; bytes += size; try { write(line); } catch { stopped = true; }
  };
  const guard = (action: () => void): void => { if (!enabled || stopped) return; try { action(); } catch { unavailable("invalid-binding"); } };
  const active = (): boolean => { if (!initialized || !started || ended) { unavailable("invalid-sequence"); return false; } return true; };
  const bindModule = (module: SuiteReporterModule, replacement = false): Binding | null => {
    if (!active()) return null;
    if (!module || typeof module !== "object" || nodeTypes.isProxy(module)) { unavailable("invalid-binding"); return null; }
    const source = suiteRelative(suitePublic(module, "moduleId")), binding = source ? modules.get(source) : undefined, specification = suiteCall(module, "toTestSpecification");
    if (!binding || suitePublic(module, "project") !== binding.specification.project || suitePublic(specification, "project") !== binding.specification.project || suitePublic(specification, "pool") !== binding.specification.pool || suiteRelative(suitePublic(specification, "moduleId")) !== source) { unavailable("invalid-binding"); return null; }
    if (binding.object && binding.object !== module) {
      if (!replacement || !binding.queued || binding.collected || binding.started || binding.cases || binding.replaced) { unavailable("invalid-binding"); return null; }
      binding.replaced = true;
    }
    binding.object = module; return binding;
  };
  const collect = (binding: Binding): boolean => {
    if (binding.cases) return true;
    const found: SuiteReporterCase[] = [], seen = new Set<SuiteReporterCase>();
    const iterable = suiteCall(suitePublic(binding.object, "children"), "allTests");
    if (!iterable || typeof iterable !== "object" || nodeTypes.isProxy(iterable)) { unavailable("invalid-binding"); return false; }
    for (const test of iterable as Iterable<SuiteReporterCase>) {
      if (cases.size + found.length >= 20000) { unavailable("capacity-exhausted"); return false; }
      if (!test || typeof test !== "object" || nodeTypes.isProxy(test) || seen.has(test) || cases.has(test) || suitePublic(test, "module") !== binding.object) { unavailable("invalid-binding"); return false; }
      seen.add(test); found.push(test);
    }
    binding.cases = found;
    for (let index = 0; index < found.length; index++) {
      const test = found[index]!, alias = binding.public.source === "runner/workflow-orchestrator.test.ts" && suitePublic(test, "name") === PLANNER_FAILURE_CASE ? "first-implementation-planner" as const : null;
      if (alias && ++planners > 1) { unavailable("invalid-binding"); return false; }
      cases.set(test, { module: binding, public: { ordinal: index + 1, alias }, ready: false, finished: false });
    }
    return true;
  };
  const bindCase = (test: SuiteReporterCase): CaseBinding | null => {
    const binding = bindModule(suitePublic(test, "module") as SuiteReporterModule, true); if (!binding || binding.ended || !collect(binding)) return null;
    const found = cases.get(test); if (!found || found.module !== binding) { unavailable("invalid-binding"); return null; } return found;
  };
  return Object.freeze({
    onInit(_context?: unknown): void { guard(() => { if (initialized) { unavailable("invalid-sequence"); return; } let now: number; try { now = clock(); } catch { unavailable("invalid-clock"); return; } if (!finite(now)) { unavailable("invalid-clock"); return; } origin = last = now; initialized = true; emit("reporter-init", null, null, null); }); },
    onTestRunStart(specifications: readonly SuiteReporterSpecification[]): void { guard(() => {
      if (!initialized || started || ended) { unavailable("invalid-sequence"); return; }
      if (!suiteArray(specifications, 256)) { unavailable("capacity-exhausted"); return; }
      for (const specification of specifications) { const moduleId = suitePublic(specification, "moduleId"), project = suitePublic(specification, "project"), pool = suitePublic(specification, "pool"), source = suiteRelative(moduleId); if (!source || modules.has(source) || !project || typeof project !== "object" || nodeTypes.isProxy(project)) { unavailable("invalid-binding"); return; } modules.set(source, { public: { ordinal: 0, source }, specification: { moduleId: moduleId as string, project, pool }, replaced: false, queued: false, collected: false, started: false, ended: false }); }
      [...modules.values()].sort((a, b) => a.public.source < b.public.source ? -1 : 1).forEach((binding, index) => { binding.public.ordinal = index + 1; });
      started = true; emit("run-start", null, null, { module_count: modules.size });
    }); },
    onTestModuleQueued(module: SuiteReporterModule): void { guard(() => { const binding = bindModule(module); if (!binding) return; if (binding.queued || binding.collected || binding.started || binding.ended) { unavailable("invalid-sequence"); return; } binding.queued = true; emit("module-queued", binding.public, null, null); }); },
    onTestModuleCollected(module: SuiteReporterModule): void { guard(() => { const binding = bindModule(module, true); if (!binding) return; if (binding.collected || binding.started || binding.ended) { unavailable("invalid-sequence"); return; } if (!collect(binding)) return; binding.collected = true; emit("module-collected", binding.public, null, { case_count: binding.cases!.length }); }); },
    onTestModuleStart(module: SuiteReporterModule): void { guard(() => { const binding = bindModule(module, true); if (!binding) return; if (binding.started || binding.ended) { unavailable("invalid-sequence"); return; } binding.started = true; emit("module-start", binding.public, null, null); }); },
    onTestCaseReady(test: SuiteReporterCase): void { guard(() => { const binding = bindCase(test); if (!binding) return; if (!binding.module.started || binding.ready || binding.finished) { unavailable("invalid-sequence"); return; } if (open.size >= 64) { unavailable("capacity-exhausted"); return; } binding.ready = true; open.add(binding); emit("case-ready", binding.module.public, binding.public, null); }); },
    onTestCaseResult(test: SuiteReporterCase): void { guard(() => { const binding = bindCase(test); if (!binding) return; const result = suiteCall(test, "result"), state = suitePublic(result, "state"); if (!(suiteStates as readonly unknown[]).includes(state) || binding.finished || !binding.ready && state !== "skipped") { unavailable("invalid-sequence"); return; }
      let attempt: SuiteProgressAttempt | null = null; if (binding.public.alias) { attempt = "unavailable"; try { const diagnostic = suiteCall(test, "diagnostic"), retry = diagnostic ? suitePublic(diagnostic, "retryCount") : null, repeat = diagnostic ? suitePublic(diagnostic, "repeatCount") : null; if (suiteInteger(retry, Number.MAX_SAFE_INTEGER) && suiteInteger(repeat, Number.MAX_SAFE_INTEGER)) attempt = retry === 0 && repeat === 0 ? "zero" : "nonzero"; } catch { /* Public attempt evidence stays unavailable. */ } }
      binding.finished = true; open.delete(binding); const previousSequence = sequence; emit("case-result", binding.module.public, binding.public, { state: state as SuiteProgressState, original_attempt: attempt });
      if (partialEnabled && !stopped && sequence === previousSequence + 1 && state === "failed" && partialFailures < 2) { partialFailures++; try { sample({ schema_version: 1, kind: "p16-suite-sample", type: "failure", sequence, reporter_elapsed_ms: last! - origin!, module: binding.module.public, case_ordinal: binding.public.ordinal, errors: p16ResultErrors(result, binding.module.public.source), timing: null }); } catch { /* Keep the original result, write and attempt evidence intact. */ } }
    }); },
    onTestModuleEnd(module: SuiteReporterModule): void { guard(() => { const binding = bindModule(module); if (!binding) return; const state = suiteCall(module, "state"); if (!binding.started || binding.ended || !(suiteStates as readonly unknown[]).includes(state) || state === "passed" && [...open].some((test) => test.module === binding)) { unavailable("invalid-sequence"); return; } binding.ended = true; const previousSequence = sequence; emit("module-end", binding.public, null, { state: state as SuiteProgressState });
      if (partialEnabled && !partialModule && !stopped && sequence === previousSequence + 1 && binding.public.source === "runner/workflow-orchestrator.test.ts") { partialModule = true; try { const elapsed = last! - origin!; sample({ schema_version: 1, kind: "p16-suite-sample", type: "module", sequence, reporter_elapsed_ms: elapsed, module: binding.public, case_ordinal: null, errors: null, timing: p16ReporterTiming(module, binding.public, elapsed, state as SuiteProgressState) }); } catch { /* Module diagnostic is optional and called at most once. */ } }
    }); },
    onTestRunEnd(testModules: readonly SuiteReporterModule[], unhandledErrors: readonly unknown[], reason: string): void { guard(() => { if (!active()) return; if (!suiteArray(testModules, 256) || !suiteArray(unhandledErrors, 20000) || !["passed", "failed", "interrupted"].includes(reason) || reason === "passed" && open.size > 0) { unavailable("invalid-sequence"); return; } const seen = new Set<Binding>(); for (const module of testModules as unknown as SuiteReporterModule[]) { const binding = bindModule(module); if (!binding || seen.has(binding)) { unavailable("invalid-binding"); return; } seen.add(binding); } ended = true; emit("run-end", null, null, { reason: reason as "passed" | "failed" | "interrupted", unhandled_errors: unhandledErrors.length }); }); },
  });
}
/** Vitest loads custom reporters through their default constructor export. */
export default class SuiteProgressReporter {
  private readonly observer = createSuiteProgressReporter();
  onInit(context?: unknown): void { this.observer.onInit(context); }
  onTestRunStart(specifications: readonly SuiteReporterSpecification[]): void { this.observer.onTestRunStart(specifications); }
  onTestModuleQueued(module: SuiteReporterModule): void { this.observer.onTestModuleQueued(module); }
  onTestModuleCollected(module: SuiteReporterModule): void { this.observer.onTestModuleCollected(module); }
  onTestModuleStart(module: SuiteReporterModule): void { this.observer.onTestModuleStart(module); }
  onTestCaseReady(test: SuiteReporterCase): void { this.observer.onTestCaseReady(test); }
  onTestCaseResult(test: SuiteReporterCase): void { this.observer.onTestCaseResult(test); }
  onTestModuleEnd(module: SuiteReporterModule): void { this.observer.onTestModuleEnd(module); }
  onTestRunEnd(modules: readonly SuiteReporterModule[], errors: readonly unknown[], reason: string): void { this.observer.onTestRunEnd(modules, errors, reason); }
}

function suiteEmptyCounts(): SuiteProgressCounts { return { collected: 0, ready: 0, finished: 0, passed: 0, failed: 0, skipped: 0 }; }
function suiteCounts(value: unknown): SuiteProgressCounts | null {
  const data = suiteExact(value, suiteCountFields); if (!data || !suiteCountFields.every((key) => suiteInteger(data[key], 20000)) || data.finished !== (data.passed as number) + (data.failed as number) + (data.skipped as number) || (data.ready as number) < (data.passed as number) + (data.failed as number)) return null;
  return { collected: data.collected as number, ready: data.ready as number, finished: data.finished as number, passed: data.passed as number, failed: data.failed as number, skipped: data.skipped as number };
}
function suiteBoundedJson(value: unknown): boolean { try { return Buffer.byteLength(JSON.stringify(value)) <= SUITE_PROGRESS_LIMITS.snapshot_bytes; } catch { return false; } }
function suiteArray(value: unknown, cap: number): value is unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length > cap || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) { const property = Object.getOwnPropertyDescriptor(value, String(index)); if (!property || !Object.hasOwn(property, "value") || !property.enumerable) return false; } return true;
}
/** A snapshot is a bounded aggregate, not a persisted complete case/name catalogue. */
export function sanitizeSuiteProgressSnapshot(value: unknown): SuiteProgressSnapshot | null {
  try {
    const data = suiteExact(value, ["schema_version", "availability", "unavailable_reason", "sequence", "reporter_elapsed_ms", "module_count", "modules", "counts", "open_cases", "tail", "run_end", "planner_result"]);
    if (!data || data.schema_version !== 1 || !["available", "unavailable"].includes(data.availability as string) || !suiteInteger(data.sequence, 50000, 1) || data.reporter_elapsed_ms !== null && !spanTime(data.reporter_elapsed_ms) || data.module_count !== null && !suiteInteger(data.module_count, 256) || !suiteArray(data.modules, 256) || !suiteArray(data.open_cases, 64) || !suiteArray(data.tail, 32)) return null;
    if (data.availability === "available" ? data.unavailable_reason !== null || data.reporter_elapsed_ms === null : ![...suiteReasons, "invalid-transport"].includes(data.unavailable_reason as SuiteProgressReason | "invalid-transport")) return null;
    const counts = suiteCounts(data.counts); if (!counts) return null;
    const modules: SuiteProgressModuleSnapshot[] = [], sources = new Set<string>(), sum = suiteEmptyCounts();
    for (const input of data.modules) {
      const row = suiteExact(input, ["ordinal", "source", "queued", "collected", "started", "ended", "state", "counts"]); if (!row) return null;
      const module = suiteModule({ ordinal: row.ordinal, source: row.source }), observed = suiteCounts(row.counts);
      if (!module || !observed || sources.has(module.source) || modules.some((item) => item.ordinal === module.ordinal) || !["queued", "collected", "started", "ended"].every((key) => typeof row[key] === "boolean") || (row.ended ? !(suiteStates as readonly unknown[]).includes(row.state) || !row.started : row.state !== null) || !row.collected && observed.collected !== 0 || row.collected && (observed.ready > observed.collected || observed.finished > observed.collected) || observed.ready > 0 && !row.started) return null;
      sources.add(module.source); modules.push({ ...module, queued: row.queued as boolean, collected: row.collected as boolean, started: row.started as boolean, ended: row.ended as boolean, state: row.state as SuiteProgressState | null, counts: observed });
      for (const key of suiteCountFields) sum[key] += observed[key];
    }
    if (!suiteCountFields.every((key) => sum[key] === counts[key]) || data.module_count !== null && (modules.length > data.module_count || modules.some((module) => module.ordinal > (data.module_count as number))) || data.module_count === null && modules.length > 0) return null;
    if (modules.some((row, index) => index > 0 && (modules[index - 1]!.ordinal >= row.ordinal || modules[index - 1]!.source >= row.source))) return null;
    const open_cases: SuiteProgressSnapshot["open_cases"] = [], open = new Set<string>();
    for (const input of data.open_cases) { const row = suiteExact(input, ["module", "case"]); if (!row || !suiteInteger(row.module, 256, 1) || !suiteInteger(row.case, 20000, 1)) return null; const module = modules.find((item) => item.ordinal === row.module), key = `${row.module}:${row.case}`; if (!module || !module.started || module.ended && module.state === "passed" || module.collected && row.case > module.counts.collected || open.has(key)) return null; open.add(key); open_cases.push({ module: row.module, case: row.case }); }
    if (open_cases.length > counts.ready || modules.some((module) => open_cases.filter((test) => test.module === module.ordinal).length > module.counts.ready)) return null;
    const tail: SuiteProgressFrame[] = []; for (const input of data.tail) { const frame = sanitizeSuiteProgressFrame(input); if (!frame || tail.length > 0 && frame.sequence !== tail.at(-1)!.sequence + 1 || frame.sequence > data.sequence || frame.reporter_elapsed_ms !== null && data.reporter_elapsed_ms !== null && frame.reporter_elapsed_ms > data.reporter_elapsed_ms) return null; tail.push(frame); }
    if (tail.length === 0 || tail.at(-1)!.sequence !== data.sequence || tail.some((frame, index) => frame.event === "observer-unavailable" && (index !== tail.length - 1 || data.availability !== "unavailable"))) return null;
    let run_end: SuiteProgressSnapshot["run_end"] = null, planner_result: SuiteProgressSnapshot["planner_result"] = null;
    if (data.run_end !== null) { const row = suiteExact(data.run_end, ["reason", "unhandled_errors"]); if (!row || !["passed", "failed", "interrupted"].includes(row.reason as string) || !suiteInteger(row.unhandled_errors, 20000)) return null; run_end = { reason: row.reason as "passed" | "failed" | "interrupted", unhandled_errors: row.unhandled_errors }; if (run_end.reason === "passed" && (open_cases.length > 0 || counts.failed > 0 || modules.some((module) => module.state === "failed"))) return null; }
    if (data.planner_result !== null) { const row = suiteExact(data.planner_result, ["module", "case", "state", "original_attempt"]); if (!row || !suiteInteger(row.module, 256, 1) || !suiteInteger(row.case, 20000, 1) || !(suiteStates as readonly unknown[]).includes(row.state) || !(suiteAttempts as readonly unknown[]).includes(row.original_attempt) || !modules.some((module) => module.ordinal === row.module && module.source === "runner/workflow-orchestrator.test.ts" && (!module.collected || (row.case as number) <= module.counts.collected) && module.counts[row.state as SuiteProgressState] > 0)) return null; planner_result = { module: row.module, case: row.case, state: row.state as SuiteProgressState, original_attempt: row.original_attempt as SuiteProgressAttempt }; }
    const snapshot: SuiteProgressSnapshot = { schema_version: 1, availability: data.availability as SuiteProgressSnapshot["availability"], unavailable_reason: data.unavailable_reason as SuiteProgressSnapshot["unavailable_reason"], sequence: data.sequence, reporter_elapsed_ms: data.reporter_elapsed_ms as number | null, module_count: data.module_count as number | null, modules, counts, open_cases, tail, run_end, planner_result };
    return suiteBoundedJson(snapshot) ? snapshot : null;
  } catch { return null; }
}
/** Stateful validation is shared by stderr framing and source-bound IPC deltas. */
export function createSuiteProgressProjection() {
  const modules = new Map<number, SuiteProgressModuleSnapshot>(), cases = new Map<string, { module: number; ordinal: number; alias: SuiteProgressCase["alias"]; ready: boolean; finished: boolean; state?: SuiteProgressState }>();
  let current: SuiteProgressSnapshot | null = null, invalid = false, initialized = false, started = false, plannerKey: string | undefined;
  const revoke = (reason: SuiteProgressSnapshot["unavailable_reason"] = "invalid-transport") => { invalid = true; if (current) { current.availability = "unavailable"; current.unavailable_reason = reason; } };
  const accept = (input: unknown): boolean => {
    if (invalid) return false;
    const frame = sanitizeSuiteProgressFrame(input); if (!frame) { revoke(); return false; }
    if (frame.sequence !== (current?.sequence ?? 0) + 1 || current?.run_end && frame.event !== "observer-unavailable" || frame.reporter_elapsed_ms !== null && current?.reporter_elapsed_ms !== null && current?.reporter_elapsed_ms !== undefined && frame.reporter_elapsed_ms < current.reporter_elapsed_ms) { revoke(); return false; }
    if (!current) current = { schema_version: 1, availability: "available", unavailable_reason: null, sequence: 0, reporter_elapsed_ms: null, module_count: null, modules: [], counts: suiteEmptyCounts(), open_cases: [], tail: [], run_end: null, planner_result: null };
    const snapshot = current;
    const fail = (): false => { revoke(); return false; };
    if (frame.event === "observer-unavailable") { snapshot.sequence = frame.sequence; snapshot.tail.push(frame); snapshot.tail = snapshot.tail.slice(-32); revoke(frame.data.reason); return true; }
    if (!initialized && frame.event !== "reporter-init") return fail();
    if (frame.event === "reporter-init") { if (initialized || frame.reporter_elapsed_ms !== 0 || frame.sequence !== 1) return fail(); initialized = true; }
    else if (frame.event === "run-start") { if (started || snapshot.module_count !== null) return fail(); started = true; snapshot.module_count = frame.data.module_count; }
    else if (!started) return fail();
    let module: SuiteProgressModuleSnapshot | undefined;
    if (frame.module) {
      module = modules.get(frame.module.ordinal);
      if (module && module.source !== frame.module.source || frame.module.ordinal > (snapshot.module_count ?? 0)) return fail();
      if (!module) { if (modules.size >= 256 || [...modules.values()].some((row) => row.source === frame.module!.source)) return fail(); module = { ...frame.module, queued: false, collected: false, started: false, ended: false, state: null, counts: suiteEmptyCounts() }; modules.set(module.ordinal, module); }
      if (module.ended) return fail();
    }
    if (frame.event === "module-queued") { if (!module || module.queued || module.collected || module.started) return fail(); module.queued = true; }
    if (frame.event === "module-collected") { if (!module || module.collected || module.started || module.counts.finished > frame.data.case_count || [...cases.values()].some((test) => test.module === module!.ordinal && test.ordinal > frame.data.case_count) || snapshot.counts.collected + frame.data.case_count > 20000) return fail(); module.collected = true; module.counts.collected = frame.data.case_count; snapshot.counts.collected += frame.data.case_count; }
    if (frame.event === "module-start") { if (!module || module.started) return fail(); module.started = true; }
    if (frame.case) {
      if (!module || module.collected && frame.case.ordinal > module.counts.collected || frame.case.alias && module.source !== "runner/workflow-orchestrator.test.ts") return fail();
      const key = `${module.ordinal}:${frame.case.ordinal}`; let test = cases.get(key);
      if (!test) { if (cases.size >= 20000) return fail(); test = { module: module.ordinal, ordinal: frame.case.ordinal, alias: frame.case.alias, ready: false, finished: false }; cases.set(key, test); }
      if (test.alias !== frame.case.alias || test.finished) return fail();
      if (frame.case.alias) { if (plannerKey !== undefined && plannerKey !== key) return fail(); plannerKey = key; }
      if (frame.event === "case-ready") { if (!module.started || test.ready || snapshot.open_cases.length >= 64 || snapshot.counts.ready >= 20000) return fail(); test.ready = true; module.counts.ready++; snapshot.counts.ready++; snapshot.open_cases.push({ module: module.ordinal, case: test.ordinal }); }
      if (frame.event === "case-result") {
        if (!test.ready && frame.data.state !== "skipped" || snapshot.counts.finished >= 20000) return fail(); test.finished = true; test.state = frame.data.state; module.counts.finished++; snapshot.counts.finished++; module.counts[frame.data.state]++; snapshot.counts[frame.data.state]++;
        snapshot.open_cases = snapshot.open_cases.filter((row) => row.module !== module!.ordinal || row.case !== test!.ordinal);
        if (frame.case.alias) snapshot.planner_result = { module: module.ordinal, case: test.ordinal, state: frame.data.state, original_attempt: frame.data.original_attempt! };
      }
    }
    if (frame.event === "module-end") { if (!module || !module.started || frame.data.state === "passed" && (snapshot.open_cases.some((test) => test.module === module!.ordinal) || module.counts.failed > 0 || module.collected && module.counts.finished !== module.counts.collected)) return fail(); module.ended = true; module.state = frame.data.state; }
    if (frame.event === "run-end") { if (frame.data.reason === "passed" && (snapshot.open_cases.length > 0 || snapshot.counts.failed > 0 || [...modules.values()].some((row) => row.state === "failed"))) return fail(); snapshot.run_end = { ...frame.data }; }
    snapshot.sequence = frame.sequence; snapshot.reporter_elapsed_ms = frame.reporter_elapsed_ms; snapshot.modules = [...modules.values()].sort((a, b) => a.ordinal - b.ordinal); snapshot.tail.push(frame); if (snapshot.tail.length > 32) snapshot.tail.shift(); return true;
  };
  return { accept, revoke, snapshot(): SuiteProgressSnapshot | null { return current ? sanitizeSuiteProgressSnapshot(current) : null; }, reconcile(module: number, states: readonly SuiteProgressState[]): boolean { const row = modules.get(module); return !invalid && !!row && row.collected && states.length === row.counts.collected && states.every((state, index) => cases.get(`${module}:${index + 1}`)?.state === state); } };
}
function suiteParseJson(raw: string): unknown {
  const value: unknown = JSON.parse(raw), scopes: Array<Set<string>> = [];
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] === "{") scopes.push(new Set()); else if (raw[index] === "}") scopes.pop();
    else if (raw[index] === '"') { const start = index++; for (; index < raw.length; index++) { if (raw[index] === "\\") index++; else if (raw[index] === '"') break; } let next = index + 1; while (next < raw.length && /\s/.test(raw[next]!)) next++; if (raw[next] === ":") { const literal = raw.slice(start, index + 1); if (literal.includes("\\")) throw new Error(); const key = JSON.parse(literal) as string, scope = scopes.at(-1); if (!scope || scope.has(key)) throw new Error(); scope.add(key); } }
  } return value;
}
/** All stderr is drained and bounded; only exact marker frames enter the projection. */
export function createSuiteProgressCollector(progress?: (snapshot: SuiteProgressSnapshot | null) => void, onFrame?: (frame: SuiteProgressFrame) => void) {
  const projection = createSuiteProgressProjection(), decoder = new TextDecoder("utf-8", { fatal: true }), prefix = Buffer.from(SUITE_PROGRESS_MARKER);
  let line: number[] = [], discard = false, bytes = 0, frames = 0, ended = false, invalid = false;
  const notify = () => { if (progress) try { progress(projection.snapshot()); } catch { invalid = true; projection.revoke(); } };
  const fail = () => { if (!invalid) { invalid = true; projection.revoke(); notify(); } };
  const emit = () => {
    const buffer = Buffer.from(line), marker = buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix), partial = buffer.length > 0 && buffer.length < prefix.length && buffer.every((byte, index) => byte === prefix[index]);
    if (partial) fail();
    if (marker && !invalid) { frames++; if (discard || frames > 50000 || buffer.length + 1 > 2048) fail(); else try { const frame = sanitizeSuiteProgressFrame(suiteParseJson(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(prefix.length)).replace(/\r$/, ""))); if (!frame || !projection.accept(frame)) fail(); else { try { onFrame?.(frame); } catch { fail(); } notify(); } } catch { fail(); } }
    line = []; discard = false;
  };
  return {
    push(chunk: Buffer | string): void { if (ended) { fail(); return; } let buffer: Buffer; try { buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length; if (bytes > SUITE_PROGRESS_LIMITS.stderr_bytes) { fail(); return; } decoder.decode(buffer, { stream: true }); } catch { fail(); return; } if (invalid) return; for (const byte of buffer) { if (byte === 10) emit(); else if (!discard) { if (line.length < 2048) line.push(byte); else discard = true; } } },
    finish(): SuiteProgressSnapshot | null { if (!ended) { try { decoder.decode(); } catch { fail(); } if (line.length > 0) { const buffer = Buffer.from(line); if (buffer.subarray(0, Math.min(prefix.length, buffer.length)).equals(prefix.subarray(0, Math.min(prefix.length, buffer.length)))) fail(); } ended = true; } return projection.snapshot(); },
    snapshot(): SuiteProgressSnapshot | null { return projection.snapshot(); },
    reconcile(module: number, states: readonly SuiteProgressState[]): boolean { return projection.reconcile(module, states); },
  };
}
export function parseSuiteProgressOutput(output: Buffer | string): SuiteProgressSnapshot | null { const collector = createSuiteProgressCollector(); collector.push(output); return collector.finish(); }

export const SUITE_PROGRESS_SOURCES = Object.freeze([...fsDiagnosticSources, "vitest.config.ts", "package.json", "pnpm-lock.yaml", "node_modules/vitest/dist/chunks/reporters.d.DtoKVV2s.d.ts", "node_modules/vitest/dist/chunks/cli-api.CnMVyzaz.js", "node_modules/vitest/dist/chunks/index.UpGiHP7g.js", "node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js", "node_modules/.pnpm/@vitest+runner@4.1.11/node_modules/@vitest/runner/dist/chunk-artifact.js"] as const);
const suiteContractHashes = ["7fa6fdc6eeeb3850e6b3166836f8c9199594c4f4bed3cee02cac0ca33d71894d", "a236001d048380e2c67d05423fc9ea3f26b07ee019ba8d6e622082f29d49102e", "cdafaf8e508042dddba72f8c7bbae84e2836ddb6b06c7026520c35d91af4e798", "e509f3cc1bd81ae6426265253fa926cbde02be5cebfe35b1df422017bffdca31", "bf6af6d2f4469911879a67e83b8f9e7b20332cf42795032c53457b10ccc1c617"];
export const SUITE_PROGRESS_CONTRACT_HASHES: readonly string[] = Object.freeze([...suiteContractHashes]);
export interface SuiteProgressSourceMetadata { role: "suite-progress-source"; fixture_sha256: string; sourceLimits: PlannerFailureSourceLimits; source_hashes: Record<string, string> }
function suiteHashes(value: unknown, complete = false): Record<string, string> | null {
  const input = suiteRecord(value, SUITE_PROGRESS_SOURCES.length); if (!input || complete && Object.keys(input).length !== SUITE_PROGRESS_SOURCES.length) return null;
  const result: Record<string, string> = {}; for (const [key, hash] of Object.entries(input)) { if (!(SUITE_PROGRESS_SOURCES as readonly string[]).includes(key) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return null; result[key] = hash; } return result;
}
export function sanitizeSuiteProgressSourceMetadata(value: unknown): SuiteProgressSourceMetadata | null {
  try { const data = suiteExact(value, ["role", "fixture_sha256", "sourceLimits", "source_hashes"]); if (!data || data.role !== "suite-progress-source") return null; const source = sanitizePlannerFailureSourceMetadata({ role: "planner-failure-source", fixture_sha256: data.fixture_sha256, sourceLimits: data.sourceLimits }), hashes = suiteHashes(data.source_hashes, true); if (!source || !hashes || hashes["runner/workflow-orchestrator.test.ts"] !== source.fixture_sha256 || !suiteContractHashes.every((hash, index) => hashes[SUITE_PROGRESS_SOURCES[11 + index]!] === hash)) return null; const result: SuiteProgressSourceMetadata = { role: "suite-progress-source", fixture_sha256: source.fixture_sha256, sourceLimits: source.sourceLimits, source_hashes: hashes }; return suiteBoundedJson(result) ? result : null; } catch { return null; }
}
export interface SuiteProgressJsonSummary { passed: boolean; module_count: number; passed_tests: number; failed_tests: number; skipped_tests: number; first_planner: { passed: boolean; test_ms: number } | null }
function suiteJsonSummary(value: unknown): SuiteProgressJsonSummary | null {
  const data = suiteExact(value, ["passed", "module_count", "passed_tests", "failed_tests", "skipped_tests", "first_planner"]); if (!data || typeof data.passed !== "boolean" || !suiteInteger(data.module_count, 256) || !["passed_tests", "failed_tests", "skipped_tests"].every((key) => suiteInteger(data[key], 20000)) || (data.passed_tests as number) + (data.failed_tests as number) + (data.skipped_tests as number) > 20000) return null;
  let first_planner: SuiteProgressJsonSummary["first_planner"] = null; if (data.first_planner !== null) { const planner = suiteExact(data.first_planner, ["passed", "test_ms"]); if (!planner || typeof planner.passed !== "boolean" || !spanTime(planner.test_ms)) return null; first_planner = { passed: planner.passed, test_ms: planner.test_ms }; }
  if (data.passed && (data.failed_tests !== 0 || data.passed_tests === 0)) return null;
  return { passed: data.passed, module_count: data.module_count, passed_tests: data.passed_tests as number, failed_tests: data.failed_tests as number, skipped_tests: data.skipped_tests as number, first_planner };
}
/** Separate P10 JSON reconciliation: nested suite totals are never module totals. */
export function summarizeSuiteProgressJson(output: string, observed: SuiteProgressSnapshot, reconcile?: (module: number, states: readonly SuiteProgressState[]) => boolean): SuiteProgressJsonSummary | null {
  try {
    const snapshot = sanitizeSuiteProgressSnapshot(observed); if (!snapshot || snapshot.availability !== "available" || snapshot.module_count === null || snapshot.modules.length !== snapshot.module_count || Buffer.byteLength(output) > OUTPUT_LIMIT) return null;
    const start = output.search(/\{\s*"numTotalTestSuites"\s*:/); if (start < 0) return null;
    const data = plainAggregate(suiteParseJson(output.slice(start))); if (!data || typeof data.success !== "boolean" || !suiteInteger(data.numTotalTestSuites, 20000) || !suiteArray(data.testResults, 256) || data.testResults.length !== snapshot.module_count) return null;
    let passed_tests = 0, failed_tests = 0, skipped_tests = 0, planners = 0, failed_module = false, first_planner: SuiteProgressJsonSummary["first_planner"] = null; const seen = new Set<string>();
    for (const input of data.testResults) {
      const module = plainAggregate(input); if (!module || !suiteArray(module.assertionResults, 20000)) return null;
      const source = suiteRelative(module.name), binding = snapshot.modules.find((row) => row.source === source); if (!source || !binding || seen.has(source) || !binding.collected || module.assertionResults.length !== binding.counts.collected) return null; seen.add(source);
      if (!["passed", "failed"].includes(module.status as string) || binding.ended && (binding.state === "failed") !== (module.status === "failed")) return null; if (module.status === "failed") failed_module = true;
      const counts = suiteEmptyCounts(), states: SuiteProgressState[] = [];
      for (let index = 0; index < module.assertionResults.length; index++) {
        const test = plainAggregate(module.assertionResults[index]); if (!test) return null;
        const state = test.status === "passed" ? "passed" : test.status === "failed" ? "failed" : ["pending", "todo", "skipped"].includes(test.status as string) ? "skipped" : null; if (!state) return null; states.push(state); counts[state]++; counts.finished++;
        if (source === "runner/workflow-orchestrator.test.ts" && (test.title === PLANNER_FAILURE_CASE || typeof test.fullName === "string" && test.fullName.endsWith(` ${PLANNER_FAILURE_CASE}`))) { planners++; if (!spanTime(test.duration) || snapshot.planner_result?.module !== binding.ordinal || snapshot.planner_result.case !== index + 1 || snapshot.planner_result.state !== state) return null; first_planner = { passed: state === "passed", test_ms: test.duration }; }
      }
      if (["finished", "passed", "failed", "skipped"].some((key) => counts[key as keyof SuiteProgressCounts] !== binding.counts[key as keyof SuiteProgressCounts]) || reconcile && !reconcile(binding.ordinal, states)) return null;
      passed_tests += counts.passed; failed_tests += counts.failed; skipped_tests += counts.skipped;
    }
    if (planners > 1 || planners === 0 && snapshot.planner_result !== null || planners === 1 && !first_planner || passed_tests !== snapshot.counts.passed || failed_tests !== snapshot.counts.failed || skipped_tests !== snapshot.counts.skipped) return null;
    if (data.success && (failed_module || failed_tests > 0 || Object.hasOwn(data, "numFailedTestSuites") && data.numFailedTestSuites !== 0)) return null;
    // Assertion statuses are counted once. numPendingTests/numTodoTests can overlap.
    if (Object.hasOwn(data, "numTotalTests") && data.numTotalTests !== passed_tests + failed_tests + skipped_tests || Object.hasOwn(data, "numPassedTests") && data.numPassedTests !== passed_tests || Object.hasOwn(data, "numFailedTests") && data.numFailedTests !== failed_tests) return null;
    return suiteJsonSummary({ passed: data.success && !failed_module && failed_tests === 0 && passed_tests > 0, module_count: seen.size, passed_tests, failed_tests, skipped_tests, first_planner });
  } catch { return null; }
}
export function suiteProgressArguments(): string[] { return [join(repository, "node_modules/vitest/vitest.mjs"), "run", "--reporter=json", `--reporter=${script}`]; }
export function suiteProgressEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv { return { ...profileEnvironment(source), SURTEC_TEST_SUITE_PROGRESS_PROFILE: "1", SURTEC_TEST_PLANNER_SPAN_PROFILE: "1" }; }
export interface SuiteProgressDiagnosticReport {
  schema_version: 1; workload: "full-suite-progress"; diagnostic_only: true; acceptance: false; status: "completed" | "failed" | "deadline"; wall_ms: number; wall_limit_ms: number; cleanup_reserve_ms: number;
  source_hashes: Record<string, string>; source_hashes_after: Record<string, string>; source_drift: boolean | null; progress: SuiteProgressSnapshot | null; receipt: PlannerSpanReceipt | null; json: SuiteProgressJsonSummary | null;
  native_exit: { code: number | null; signal: "SIGTERM" | "SIGKILL" | "other" | null; received_ms: number } | null; stdio_close: { exit_code: number | null; closed: boolean; expired: boolean; failed: boolean } | null; last_progress_received_ms: number | null;
  cleanup: PlannerFsDiagnosticReport["cleanup"]; limitations: string[];
}
const suiteProgressLimitations = ["Reporter times are main-process delivery observations, not worker execution instants or causal durations; open boundaries and last receipt age do not establish liveness.", "Progress, the immutable pre-cleanup P09 receipt, public post-hook Planner result, framework run end, complete JSON, native exit, stdio close, source freeze and narrow fixture cleanup are independent facts.", "The fixed original full workload, two workers and original limits are unchanged; observer and native enqueue overhead remain inside the shared deadline.", "Source and child bindings are consistency evidence, not authenticated provenance against same-user forgery; partial observations never grant acceptance or cleanup authority."];
export const SUITE_PROGRESS_LIMITATIONS: readonly string[] = Object.freeze([...suiteProgressLimitations]);
function suiteUnavailableReport(deadline: ProfileDeadline, expired = false): SuiteProgressDiagnosticReport { return { schema_version: 1, workload: "full-suite-progress", diagnostic_only: true, acceptance: false, status: expired ? "deadline" : "failed", wall_ms: deadline.elapsed(), wall_limit_ms: PROFILE_LIMIT_MS, cleanup_reserve_ms: PROFILE_CLEANUP_RESERVE_MS, source_hashes: {}, source_hashes_after: {}, source_drift: null, progress: null, receipt: null, json: null, native_exit: null, stdio_close: null, last_progress_received_ms: null, cleanup: "unavailable-no-uncertain-fixture-deleted", limitations: [...suiteProgressLimitations] }; }
function suiteExit(value: unknown): SuiteProgressDiagnosticReport["native_exit"] {
  const data = suiteExact(value, ["code", "signal", "received_ms"]); return data && (data.code === null || suiteInteger(data.code, 2147483647)) && [null, "SIGTERM", "SIGKILL", "other"].includes(data.signal as null | string) && (data.code === null || data.signal === null) && spanTime(data.received_ms) ? { code: data.code as number | null, signal: data.signal as "SIGTERM" | "SIGKILL" | "other" | null, received_ms: data.received_ms } : null;
}
function suiteIsComplete(report: SuiteProgressDiagnosticReport): boolean {
  const progress = report.progress, receipt = report.receipt;
  return report.wall_ms <= PROFILE_LIMIT_MS && progress?.availability === "available" && progress.module_count !== null && progress.module_count > 0 && progress.modules.length === progress.module_count && progress.modules.every((module) => module.collected && module.started && module.ended && module.state !== "failed" && module.counts.finished === module.counts.collected) && progress.open_cases.length === 0 && progress.run_end?.reason === "passed" && progress.run_end.unhandled_errors === 0 && progress.planner_result?.state === "passed" && progress.planner_result.original_attempt === "zero" && receipt?.failure_receipt.capture_status === "captured" && receipt.failure_receipt.framework_state === "pass" && receipt.span_cursor.timing_status === "captured" && PLANNER_SPAN_PHASES.every((phase) => receipt.span_cursor.timing_status === "captured" && receipt.span_cursor.phases[phase].state === "ended") && report.json?.passed === true && report.json.first_planner?.passed === true && report.json.module_count === progress.module_count && report.json.passed_tests === progress.counts.passed && report.json.failed_tests === progress.counts.failed && report.json.skipped_tests === progress.counts.skipped && report.native_exit?.code === 0 && report.native_exit.signal === null && report.stdio_close?.closed === true && !report.stdio_close.expired && !report.stdio_close.failed && report.stdio_close.exit_code === 0 && report.source_drift === false && Object.keys(report.source_hashes).length === SUITE_PROGRESS_SOURCES.length && report.cleanup === "verified-normal-suite-and-no-new-planner-prefix-roots";
}
/** Pure closed P10 IPC/final projection; never reads source files. */
export function sanitizeSuiteProgressDiagnostic(value: unknown, sourceLimits?: PlannerFailureSourceLimits | null): SuiteProgressDiagnosticReport | null {
  try {
    const data = suiteExact(value, ["schema_version", "workload", "diagnostic_only", "acceptance", "status", "wall_ms", "wall_limit_ms", "cleanup_reserve_ms", "source_hashes", "source_hashes_after", "source_drift", "progress", "receipt", "json", "native_exit", "stdio_close", "last_progress_received_ms", "cleanup", "limitations"]);
    if (!data || data.schema_version !== 1 || data.workload !== "full-suite-progress" || data.diagnostic_only !== true || data.acceptance !== false || !["completed", "failed", "deadline"].includes(data.status as string) || !finite(data.wall_ms) || data.wall_limit_ms !== PROFILE_LIMIT_MS || data.cleanup_reserve_ms !== PROFILE_CLEANUP_RESERVE_MS || ![true, false, null].includes(data.source_drift as boolean | null) || data.last_progress_received_ms !== null && (!spanTime(data.last_progress_received_ms) || data.last_progress_received_ms > data.wall_ms) || !["verified-normal-suite-and-no-new-planner-prefix-roots", "unavailable-no-uncertain-fixture-deleted"].includes(data.cleanup as string) || !suiteArray(data.limitations, suiteProgressLimitations.length) || data.limitations.some((line, index) => line !== suiteProgressLimitations[index])) return null;
    const source_hashes = suiteHashes(data.source_hashes), source_hashes_after = suiteHashes(data.source_hashes_after), progress = data.progress === null ? null : sanitizeSuiteProgressSnapshot(data.progress), receipt = data.receipt === null ? null : sanitizePlannerSpanReceipt(data.receipt, sourceLimits ?? null), json = data.json === null ? null : suiteJsonSummary(data.json), native_exit = data.native_exit === null ? null : suiteExit(data.native_exit);
    if (!source_hashes || !source_hashes_after || data.progress !== null && !progress || data.receipt !== null && !receipt || data.json !== null && !json || data.native_exit !== null && (!native_exit || native_exit.received_ms > data.wall_ms) || data.source_drift !== null && (Object.keys(source_hashes).length !== SUITE_PROGRESS_SOURCES.length || Object.keys(source_hashes_after).length !== SUITE_PROGRESS_SOURCES.length || sourceHashesChanged(source_hashes, source_hashes_after) !== data.source_drift)) return null;
    let stdio_close: SuiteProgressDiagnosticReport["stdio_close"] = null; if (data.stdio_close !== null) { const close = suiteExact(data.stdio_close, ["exit_code", "closed", "expired", "failed"]); if (!close || close.exit_code !== null && !suiteInteger(close.exit_code, 2147483647) || !["closed", "expired", "failed"].every((key) => typeof close[key] === "boolean") || !close.closed && close.exit_code !== null) return null; stdio_close = { exit_code: close.exit_code as number | null, closed: close.closed as boolean, expired: close.expired as boolean, failed: close.failed as boolean }; }
    if (native_exit && stdio_close?.closed && native_exit.code !== stdio_close.exit_code || progress === null && data.last_progress_received_ms !== null || json && (!progress || json.module_count !== progress.module_count || json.passed_tests !== progress.counts.passed || json.failed_tests !== progress.counts.failed || json.skipped_tests !== progress.counts.skipped)) return null;
    const report: SuiteProgressDiagnosticReport = { schema_version: 1, workload: "full-suite-progress", diagnostic_only: true, acceptance: false, status: data.status as SuiteProgressDiagnosticReport["status"], wall_ms: data.wall_ms, wall_limit_ms: PROFILE_LIMIT_MS, cleanup_reserve_ms: PROFILE_CLEANUP_RESERVE_MS, source_hashes, source_hashes_after, source_drift: data.source_drift as boolean | null, progress, receipt, json, native_exit, stdio_close, last_progress_received_ms: data.last_progress_received_ms as number | null, cleanup: data.cleanup as SuiteProgressDiagnosticReport["cleanup"], limitations: [...suiteProgressLimitations] };
    return suiteBoundedJson(report) && (report.status !== "completed" || suiteIsComplete(report)) ? report : null;
  } catch { return null; }
}

async function runLoadedSuiteProgress(deadline: ProfileDeadline, metadata: (source: SuiteProgressSourceMetadata) => void, delta: (message: unknown) => void): Promise<SuiteProgressDiagnosticReport> {
  const report = suiteUnavailableReport(deadline); let output = "", outputBytes = 0, oversized = false, stdoutInvalid = false, receiptSeen = false, receiptRevoked = false;
  try {
    report.source_hashes = sourceHashes(SUITE_PROGRESS_SOURCES);
    if (!suiteContractHashes.every((hash, index) => report.source_hashes[SUITE_PROGRESS_SOURCES[11 + index]!] === hash)) return report;
    const fixture = preparePlannerFailureSourceMetadata(); if (!fixture || fixture.fixture_sha256 !== report.source_hashes["runner/workflow-orchestrator.test.ts"]) return report;
    const handshake = sanitizeSuiteProgressSourceMetadata({ role: "suite-progress-source", fixture_sha256: fixture.fixture_sha256, sourceLimits: fixture.sourceLimits, source_hashes: report.source_hashes }); if (!handshake) return report;
    metadata(handshake); const before = prefixInventory("surtec-workflow-worker-"); if (!deadline.mayLaunch()) { report.status = "deadline"; return report; }
    const collector = createSuiteProgressCollector(undefined, (frame) => { const received_ms = deadline.elapsed(); if (!spanTime(received_ms)) return; report.last_progress_received_ms = received_ms; delta({ role: "suite-progress-frame", frame, received_ms }); });
    const spans = createPlannerSpanMarkerCollector((receipt) => {
      if (!receipt || receiptSeen) { receiptRevoked = true; report.receipt = null; delta({ role: "suite-progress-receipt-unavailable" }); return; }
      receiptSeen = true; report.receipt = receipt; delta({ role: "suite-progress-receipt", receipt, received_ms: deadline.elapsed() });
    }, handshake.sourceLimits);
    const stdoutDecoder = new TextDecoder("utf-8", { fatal: true });
    const child = spawn(process.execPath, suiteProgressArguments(), { cwd: repository, env: suiteProgressEnvironment(process.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.once("exit", (code, signal) => {
      const observation = suiteExit({ code, signal: signal === null ? null : signal === "SIGTERM" || signal === "SIGKILL" ? signal : "other", received_ms: deadline.elapsed() });
      if (observation) { report.native_exit = observation; try { delta({ role: "suite-progress-exit", native_exit: observation }); } catch { /* Missing IPC remains unknown. */ } }
    });
    const pending = superviseChild(child, deadline);
    child.stdout?.on("data", (chunk: Buffer) => { outputBytes += chunk.length; spans.push(chunk); if (outputBytes > OUTPUT_LIMIT) { oversized = true; return; } try { output += stdoutDecoder.decode(chunk, { stream: true }); } catch { stdoutInvalid = true; } });
    child.stderr?.on("data", (chunk: Buffer) => { collector.push(chunk); });
    const outcome = await pending; report.stdio_close = outcome; report.progress = collector.finish();
    try { output += stdoutDecoder.decode(); } catch { stdoutInvalid = true; }
    const receipt = spans.finish(); report.receipt = !receiptRevoked ? receipt : null;
    if (receiptSeen && !report.receipt) { receiptRevoked = true; delta({ role: "suite-progress-receipt-unavailable" }); }
    if (!oversized && !stdoutInvalid && outcome.closed && report.progress) report.json = summarizeSuiteProgressJson(output, report.progress, collector.reconcile);
    report.status = outcome.expired ? "deadline" : "failed";
    const normal = outcome.closed && !outcome.expired && !outcome.failed && outcome.exit_code === 0 && report.native_exit?.code === 0 && report.native_exit.signal === null && !oversized && !stdoutInvalid;
    if (normal && report.json?.passed && report.json.first_planner?.passed && [...prefixInventory("surtec-workflow-worker-")].every((name) => before.has(name))) report.cleanup = "verified-normal-suite-and-no-new-planner-prefix-roots";
    if (deadline.remaining() > 0) { report.source_hashes_after = sourceHashes(SUITE_PROGRESS_SOURCES); report.source_drift = sourceHashesChanged(report.source_hashes, report.source_hashes_after); }
    report.wall_ms = deadline.elapsed(); if (suiteIsComplete(report)) report.status = "completed";
  } catch { report.status = deadline.remaining() <= 0 ? "deadline" : "failed"; }
  report.wall_ms = deadline.elapsed(); if (deadline.remaining() <= 0) { report.status = "deadline"; report.cleanup = "unavailable-no-uncertain-fixture-deleted"; } return report;
}
interface SuiteControllerChild extends SupervisedChild { on(event: "message", listener: (value: unknown) => void): unknown; send(message: { role: "suite-progress-controller"; origin_ms: number }): unknown }
/** Filesystem-free watchdog. IPC carries bounded detached deltas, never 50k full snapshots. */
export async function runSuiteProgressDiagnosticWatchdog(deadline = new ProfileDeadline(), launch: () => SuiteControllerChild = () => fork(script, [], { cwd: repository, execArgv: ["--import", "tsx"], env: profileEnvironment(process.env), stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true })): Promise<SuiteProgressDiagnosticReport> {
  if (!deadline.mayLaunch()) return suiteUnavailableReport(deadline, true);
  const projection = createSuiteProgressProjection(); let source: SuiteProgressSourceMetadata | null = null, sourceSeen = false, finalSeen = false, revoked = false, finalReport: SuiteProgressDiagnosticReport | null = null, receipt: PlannerSpanReceipt | null = null, receiptSeen = false, exit: SuiteProgressDiagnosticReport["native_exit"] = null, received: number | null = null, lastDelivery = 0, ipcBytes = 0, ipcMessages = 0;
  const unavailable = (expired: boolean): SuiteProgressDiagnosticReport => { const report = suiteUnavailableReport(deadline, expired); if (!revoked) { report.source_hashes = source?.source_hashes ?? {}; report.progress = projection.snapshot(); report.last_progress_received_ms = report.progress ? received : null; report.receipt = receipt; report.native_exit = exit; } return report; };
  try {
    const controller = launch(), cancellation = new AbortController(), pending = superviseChild(controller, deadline, 1000, cancellation.signal, "cleanup");
    controller.stdout?.on?.("data", () => {}); controller.stderr?.on?.("data", () => {});
    controller.on("message", (value) => {
      if (revoked) return;
      try {
        const data = plainAggregate(value); if (!data || finalSeen || ++ipcMessages > 50008) { revoked = true; return; }
        if (data.role === "suite-progress-source") {
          if (sourceSeen) { revoked = true; return; } sourceSeen = true; source = sanitizeSuiteProgressSourceMetadata(value); if (!source) { revoked = true; return; } ipcBytes += Buffer.byteLength(JSON.stringify(source)); return;
        }
        if (!source || !sourceSeen) { revoked = true; return; }
        if (data.role === "suite-progress-frame") {
          if (!suiteExact(value, ["role", "frame", "received_ms"]) || !spanTime(data.received_ms) || data.received_ms < lastDelivery || data.received_ms > deadline.elapsed()) { revoked = true; return; }
          const frame = sanitizeSuiteProgressFrame(data.frame); if (!frame || !projection.accept(frame)) { revoked = true; return; } lastDelivery = data.received_ms; received = data.received_ms; ipcBytes += Buffer.byteLength(JSON.stringify(frame)) + 128;
        } else if (data.role === "suite-progress-receipt") {
          if (!suiteExact(value, ["role", "receipt", "received_ms"]) || receiptSeen || !spanTime(data.received_ms) || data.received_ms < lastDelivery || data.received_ms > deadline.elapsed()) { revoked = true; return; } receiptSeen = true; receipt = sanitizePlannerSpanReceipt(data.receipt, source.sourceLimits); if (!receipt) { revoked = true; return; } lastDelivery = data.received_ms; ipcBytes += Buffer.byteLength(JSON.stringify(receipt)) + 128;
        } else if (data.role === "suite-progress-exit") {
          if (!suiteExact(value, ["role", "native_exit"]) || exit) { revoked = true; return; } exit = suiteExit(data.native_exit); if (!exit || exit.received_ms < lastDelivery || exit.received_ms > deadline.elapsed()) { revoked = true; return; } lastDelivery = exit.received_ms; ipcBytes += 256;
        } else if (data.role === "suite-progress-report") {
          if (!suiteExact(value, ["role", "report"])) { revoked = true; return; } finalSeen = true;
          const report = sanitizeSuiteProgressDiagnostic(data.report, source.sourceLimits), snapshot = projection.snapshot();
          if (!report || report.wall_ms < lastDelivery || report.wall_ms > deadline.elapsed() || sourceHashesChanged(source.source_hashes, report.source_hashes) || JSON.stringify(report.progress) !== JSON.stringify(snapshot) || JSON.stringify(report.receipt) !== JSON.stringify(receipt) || JSON.stringify(report.native_exit) !== JSON.stringify(exit) || report.last_progress_received_ms !== received) { revoked = true; return; }
          finalReport = report; ipcBytes += Buffer.byteLength(JSON.stringify(report));
        } else { revoked = true; return; }
        if (ipcBytes > SUITE_PROGRESS_LIMITS.stderr_bytes + 2 * SUITE_PROGRESS_LIMITS.snapshot_bytes + 50000 * 128) revoked = true;
      } catch { revoked = true; }
    });
    try { controller.send({ role: "suite-progress-controller", origin_ms: performance.timeOrigin }); } catch { cancellation.abort(); }
    const outcome = await pending;
    const report = finalReport as SuiteProgressDiagnosticReport | null;
    if (revoked || !outcome.closed || outcome.expired || outcome.failed || outcome.exit_code !== 0 || !report || deadline.remaining() <= 0) return unavailable(outcome.expired || deadline.remaining() <= 0);
    report.wall_ms = deadline.elapsed(); return report;
  } catch { return unavailable(deadline.remaining() <= 0); }
}
async function suiteProgressControllerWorker(value: unknown): Promise<void> {
  try {
    const data = suiteExact(value, ["role", "origin_ms"]); if (!data || data.role !== "suite-progress-controller" || !finite(data.origin_ms)) throw new Error();
    const origin = data.origin_ms, deadline = new ProfileDeadline(() => performance.timeOrigin + performance.now() - origin); let deliveryUnavailable = false;
    const send = (message: unknown): void => { if (deliveryUnavailable || !process.send || !process.connected) throw new Error(); const queued = process.send(message, (error) => { if (error) deliveryUnavailable = true; }); if (!queued) { deliveryUnavailable = true; throw new Error(); } };
    const report = await runLoadedSuiteProgress(deadline, send, (message) => { try { send(message); } catch { deliveryUnavailable = true; } });
    if (deliveryUnavailable || !process.send || !process.connected) throw new Error();
    process.send({ role: "suite-progress-report", report }, (error) => { if (process.connected) process.disconnect(); process.exitCode = error ? 1 : 0; });
  } catch { if (process.connected) process.disconnect(); process.exitCode = 1; }
}

// P11 bounded suite delivery costs.
export interface SuiteAttributionEndedWindow { ordinal: number; source: string; start_ms: number; end_ms: number; elapsed_ms: number; state: SuiteProgressState }
export interface SuiteAttributionOpenWindow { ordinal: number; source: string; start_ms: number; horizon_ms: number; elapsed_ms: number }
export interface SuiteAttributionCosts {
  schema_version: 1; availability: "available" | "unavailable"; unavailable_reason: SuiteProgressSnapshot["unavailable_reason"];
  sequence: number; reporter_elapsed_ms: number | null; module_count: number | null; observed_modules: number; without_start_modules: number;
  ended: { eligible_count: number; retained_count: number; omitted_count: number; sum_ms: number; union_ms: number; top: SuiteAttributionEndedWindow[] } | null;
  start_without_end: { eligible_count: number; retained_count: number; omitted_count: number; top: SuiteAttributionOpenWindow[] } | null;
}
function suiteCostSum(windows: readonly SuiteAttributionEndedWindow[]): number { return [...windows].sort((a, b) => a.ordinal - b.ordinal).reduce((sum, row) => sum + row.elapsed_ms, 0); }
function suiteCostUnion(windows: readonly SuiteAttributionEndedWindow[]): number {
  const ordered = [...windows].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || a.ordinal - b.ordinal);
  let total = 0, start: number | null = null, end = 0;
  for (const row of ordered) { if (start === null) { start = row.start_ms; end = row.end_ms; } else if (row.start_ms <= end) end = Math.max(end, row.end_ms); else { total += end - start; start = row.start_ms; end = row.end_ms; } }
  return start === null ? 0 : total + (end - start);
}
function suiteCostRanking(rows: ReadonlyArray<{ ordinal: number; elapsed_ms: number }>): boolean { return rows.every((row, index) => index === 0 || rows[index - 1]!.elapsed_ms > row.elapsed_ms || rows[index - 1]!.elapsed_ms === row.elapsed_ms && rows[index - 1]!.ordinal < row.ordinal); }
/** Closed detached cost sample; exact omitted-window totals are additionally checked against the private frame projection. */
export function sanitizeSuiteAttributionCosts(value: unknown): SuiteAttributionCosts | null {
  try {
    const data = suiteExact(value, ["schema_version", "availability", "unavailable_reason", "sequence", "reporter_elapsed_ms", "module_count", "observed_modules", "without_start_modules", "ended", "start_without_end"]);
    if (!data || data.schema_version !== 1 || !["available", "unavailable"].includes(data.availability as string) || !suiteInteger(data.sequence, 50000, 1) || data.reporter_elapsed_ms !== null && !spanTime(data.reporter_elapsed_ms) || data.module_count !== null && !suiteInteger(data.module_count, 256) || !suiteInteger(data.observed_modules, 256) || !suiteInteger(data.without_start_modules, data.observed_modules) || (data.module_count === null ? data.observed_modules !== 0 : data.observed_modules > (data.module_count as number))) return null;
    const base = { schema_version: 1 as const, availability: data.availability as SuiteAttributionCosts["availability"], unavailable_reason: data.unavailable_reason as SuiteAttributionCosts["unavailable_reason"], sequence: data.sequence, reporter_elapsed_ms: data.reporter_elapsed_ms as number | null, module_count: data.module_count as number | null, observed_modules: data.observed_modules, without_start_modules: data.without_start_modules };
    if (data.availability === "unavailable") { if (![...suiteReasons, "invalid-transport"].includes(data.unavailable_reason as SuiteProgressReason | "invalid-transport") || data.ended !== null || data.start_without_end !== null) return null; return { ...base, ended: null, start_without_end: null }; }
    if (data.unavailable_reason !== null || !spanTime(data.reporter_elapsed_ms)) return null;
    const ended = suiteExact(data.ended, ["eligible_count", "retained_count", "omitted_count", "sum_ms", "union_ms", "top"]), open = suiteExact(data.start_without_end, ["eligible_count", "retained_count", "omitted_count", "top"]);
    if (!ended || !open || !suiteArray(ended.top, 16) || !suiteArray(open.top, 4) || ![ended, open].every((row) => suiteInteger(row.eligible_count, 256) && suiteInteger(row.retained_count, 256) && suiteInteger(row.omitted_count, 256) && (row.retained_count as number) + (row.omitted_count as number) === row.eligible_count) || ended.retained_count !== ended.top.length || open.retained_count !== open.top.length || ended.retained_count !== Math.min(ended.eligible_count as number, 16) || open.retained_count !== Math.min(open.eligible_count as number, 4) || (ended.eligible_count as number) + (open.eligible_count as number) + data.without_start_modules !== data.observed_modules || !finite(ended.sum_ms) || ended.sum_ms < 0 || ended.sum_ms > 230400000 || !spanTime(ended.union_ms) || ended.union_ms > ended.sum_ms || ended.union_ms > data.reporter_elapsed_ms) return null;
    const endedRows: SuiteAttributionEndedWindow[] = [], openRows: SuiteAttributionOpenWindow[] = [], bindings: SuiteProgressModule[] = [];
    for (let index = 0; index < ended.top.length; index++) {
      const input = ended.top[index];
      const row = suiteExact(input, ["ordinal", "source", "start_ms", "end_ms", "elapsed_ms", "state"]); if (!row) return null;
      const binding = suiteModule({ ordinal: row.ordinal, source: row.source });
      if (!binding || !spanTime(row.start_ms) || !spanTime(row.end_ms) || !spanTime(row.elapsed_ms) || row.end_ms < row.start_ms || row.end_ms > data.reporter_elapsed_ms || row.elapsed_ms !== row.end_ms - row.start_ms || !(suiteStates as readonly unknown[]).includes(row.state)) return null;
      bindings.push(binding); endedRows.push({ ...binding, start_ms: row.start_ms, end_ms: row.end_ms, elapsed_ms: row.elapsed_ms, state: row.state as SuiteProgressState });
    }
    for (let index = 0; index < open.top.length; index++) {
      const input = open.top[index];
      const row = suiteExact(input, ["ordinal", "source", "start_ms", "horizon_ms", "elapsed_ms"]); if (!row) return null;
      const binding = suiteModule({ ordinal: row.ordinal, source: row.source });
      if (!binding || !spanTime(row.start_ms) || row.horizon_ms !== data.reporter_elapsed_ms || !spanTime(row.elapsed_ms) || row.start_ms > data.reporter_elapsed_ms || row.elapsed_ms !== data.reporter_elapsed_ms - row.start_ms) return null;
      bindings.push(binding); openRows.push({ ...binding, start_ms: row.start_ms, horizon_ms: data.reporter_elapsed_ms, elapsed_ms: row.elapsed_ms });
    }
    const ordered = bindings.sort((a, b) => a.ordinal - b.ordinal);
    if (ordered.some((row, index) => row.ordinal > (base.module_count ?? 0) || index > 0 && (ordered[index - 1]!.ordinal >= row.ordinal || ordered[index - 1]!.source >= row.source)) || !suiteCostRanking(endedRows) || !suiteCostRanking(openRows) || endedRows.some((row) => row.elapsed_ms > (ended.sum_ms as number) || row.elapsed_ms > (ended.union_ms as number)) || ended.eligible_count === 0 && (ended.sum_ms !== 0 || ended.union_ms !== 0) || (ended.eligible_count as number) <= 16 && (ended.sum_ms !== suiteCostSum(endedRows) || ended.union_ms !== suiteCostUnion(endedRows))) return null;
    const result: SuiteAttributionCosts = { ...base, ended: { eligible_count: ended.eligible_count as number, retained_count: ended.retained_count as number, omitted_count: ended.omitted_count as number, sum_ms: ended.sum_ms, union_ms: ended.union_ms, top: endedRows }, start_without_end: { eligible_count: open.eligible_count as number, retained_count: open.retained_count as number, omitted_count: open.omitted_count as number, top: openRows } };
    return suiteBoundedJson(result) ? result : null;
  } catch { return null; }
}
/** Prospective delivery intervals only: never a CPU, exclusive-cost or live-process measurement. */
export function createSuiteAttributionCosts() {
  const projection = createSuiteProgressProjection(), modules = new Map<number, SuiteProgressModule & { start_ms: number | null; end_ms: number | null; state: SuiteProgressState | null }>();
  let invalid = false, reason: SuiteProgressSnapshot["unavailable_reason"] = null, sequence = 0, reporter_elapsed_ms: number | null = null, module_count: number | null = null;
  const revoke = () => { invalid = true; reason ??= "invalid-transport"; projection.revoke(); };
  return {
    accept(input: SuiteProgressFrame): boolean {
      if (invalid) return false;
      const frame = sanitizeSuiteProgressFrame(input); if (!frame || !projection.accept(frame)) { revoke(); return false; }
      sequence = frame.sequence;
      if (frame.event === "observer-unavailable") { invalid = true; reason = frame.data.reason; return true; }
      reporter_elapsed_ms = frame.reporter_elapsed_ms;
      if (frame.event === "run-start") module_count = frame.data.module_count;
      if (frame.module) {
        let row = modules.get(frame.module.ordinal);
        if (!row) {
          row = { ...frame.module, start_ms: null, end_ms: null, state: null }; modules.set(row.ordinal, row);
          const ordered = [...modules.values()].sort((a, b) => a.ordinal - b.ordinal);
          if (ordered.some((item, index) => index > 0 && ordered[index - 1]!.source >= item.source)) { revoke(); reason = "invalid-binding"; return false; }
        }
        if (frame.event === "module-start") row.start_ms = frame.reporter_elapsed_ms;
        if (frame.event === "module-end") { if (row.start_ms === null) { revoke(); return false; } row.end_ms = frame.reporter_elapsed_ms; row.state = frame.data.state; }
      }
      return true;
    },
    revoke,
    snapshot(): SuiteAttributionCosts | null {
      if (sequence === 0) return null;
      const observed = projection.snapshot(); if (!observed) revoke();
      if (observed?.availability === "unavailable") { invalid = true; reason ??= observed.unavailable_reason; }
      const rows = [...modules.values()], without_start_modules = rows.filter((row) => row.start_ms === null).length;
      const base = { schema_version: 1 as const, availability: invalid ? "unavailable" as const : "available" as const, unavailable_reason: invalid ? reason ?? "invalid-transport" : null, sequence, reporter_elapsed_ms, module_count, observed_modules: rows.length, without_start_modules };
      if (invalid) return sanitizeSuiteAttributionCosts({ ...base, ended: null, start_without_end: null });
      const ended = rows.filter((row) => row.start_ms !== null && row.end_ms !== null).map((row): SuiteAttributionEndedWindow => ({ ordinal: row.ordinal, source: row.source, start_ms: row.start_ms!, end_ms: row.end_ms!, elapsed_ms: row.end_ms! - row.start_ms!, state: row.state! }));
      const open = rows.filter((row) => row.start_ms !== null && row.end_ms === null).map((row): SuiteAttributionOpenWindow => ({ ordinal: row.ordinal, source: row.source, start_ms: row.start_ms!, horizon_ms: reporter_elapsed_ms!, elapsed_ms: reporter_elapsed_ms! - row.start_ms! }));
      const ranked = <T extends { ordinal: number; elapsed_ms: number }>(values: T[]) => [...values].sort((a, b) => b.elapsed_ms - a.elapsed_ms || a.ordinal - b.ordinal);
      return sanitizeSuiteAttributionCosts({ ...base, ended: { eligible_count: ended.length, retained_count: Math.min(ended.length, 16), omitted_count: Math.max(0, ended.length - 16), sum_ms: suiteCostSum(ended), union_ms: suiteCostUnion(ended), top: ranked(ended).slice(0, 16) }, start_without_end: { eligible_count: open.length, retained_count: Math.min(open.length, 4), omitted_count: Math.max(0, open.length - 4), top: ranked(open).slice(0, 4) } });
    },
  };
}

// P11 has its own closed compact transport; historical P10 contracts remain unchanged.
export const SUITE_ATTRIBUTION_SOURCES = Object.freeze([...SUITE_PROGRESS_SOURCES, "runner/task-orchestrator.ts", "runner/run-task.ts", "node_modules/vitest/dist/chunks/test.DNmyFkvJ.js"] as const);
export const SUITE_ATTRIBUTION_CONTRACT_HASHES: readonly string[] = Object.freeze([...SUITE_PROGRESS_CONTRACT_HASHES, "f07fc8036b066834143b14748bd70c436a6a2f15f648455af8d3a003a4eafc94"]);
export interface SuiteAttributionSourceMetadata { role: "suite-attribution-source"; fixture_sha256: string; sourceLimits: PlannerFailureSourceLimits; source_hashes: Record<string, string> }
function attributionHashes(value: unknown, complete = false): Record<string, string> | null {
  const input = suiteRecord(value, 19); if (!input || complete && Object.keys(input).length !== 19) return null;
  const result: Record<string, string> = {};
  for (const [key, hash] of Object.entries(input)) { if (!(SUITE_ATTRIBUTION_SOURCES as readonly string[]).includes(key) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return null; result[key] = hash; }
  return result;
}
function attributionOriginalHashes(hashes: Record<string, string>): Record<string, string> { return Object.fromEntries(SUITE_PROGRESS_SOURCES.filter((source) => Object.hasOwn(hashes, source)).map((source) => [source, hashes[source]!])); }
export function sanitizeSuiteAttributionSourceMetadata(value: unknown): SuiteAttributionSourceMetadata | null {
  try {
    const data = suiteExact(value, ["role", "fixture_sha256", "sourceLimits", "source_hashes"]); if (!data || data.role !== "suite-attribution-source") return null;
    const hashes = attributionHashes(data.source_hashes, true); if (!hashes || hashes[SUITE_ATTRIBUTION_SOURCES[18]] !== SUITE_ATTRIBUTION_CONTRACT_HASHES[5]) return null;
    const original = sanitizeSuiteProgressSourceMetadata({ role: "suite-progress-source", fixture_sha256: data.fixture_sha256, sourceLimits: data.sourceLimits, source_hashes: attributionOriginalHashes(hashes) });
    return original ? { role: "suite-attribution-source", fixture_sha256: original.fixture_sha256, sourceLimits: original.sourceLimits, source_hashes: hashes } : null;
  } catch { return null; }
}
export function suiteAttributionArguments(): string[] { return suiteProgressArguments(); }
export function suiteAttributionEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv { return { ...suiteProgressEnvironment(source), SURTEC_TEST_PLANNER_WAIT_PROFILE: "1" }; }
export interface CompactSuiteProgress {
  availability: SuiteProgressSnapshot["availability"]; unavailable_reason: SuiteProgressSnapshot["unavailable_reason"]; sequence: number; reporter_elapsed_ms: number | null; module_count: number | null;
  observed_modules: number; queued_modules: number; collected_modules: number; started_modules: number; ended_modules: number;
  counts: SuiteProgressSnapshot["counts"]; open_case_count: number; tail: SuiteProgressFrame[]; run_end: SuiteProgressSnapshot["run_end"]; planner_result: SuiteProgressSnapshot["planner_result"];
}
export function compactSuiteProgress(value: SuiteProgressSnapshot | null): CompactSuiteProgress | null {
  const snapshot = value === null ? null : sanitizeSuiteProgressSnapshot(value); if (!snapshot) return null;
  return { availability: snapshot.availability, unavailable_reason: snapshot.unavailable_reason, sequence: snapshot.sequence, reporter_elapsed_ms: snapshot.reporter_elapsed_ms, module_count: snapshot.module_count, observed_modules: snapshot.modules.length,
    queued_modules: snapshot.modules.filter((row) => row.queued).length, collected_modules: snapshot.modules.filter((row) => row.collected).length, started_modules: snapshot.modules.filter((row) => row.started).length, ended_modules: snapshot.modules.filter((row) => row.ended).length,
    counts: snapshot.counts, open_case_count: snapshot.open_cases.length, tail: snapshot.tail, run_end: snapshot.run_end, planner_result: snapshot.planner_result };
}
export interface SuiteAttributionDiagnosticReport extends Omit<SuiteProgressDiagnosticReport, "workload" | "progress"> {
  workload: "full-suite-attribution"; progress: CompactSuiteProgress | null; wait_receipt: PlannerWaitReceipt | null; costs: SuiteAttributionCosts | null;
}
const attributionLimitations = [
  ...suiteProgressLimitations,
  "P11 is one immutable pre-stop worker observation; fake executor body return, native attempt settlement, terminal persistence and cleanup are distinct. Late notifications are unobserved.",
  "Module rankings are inclusive reporter-delivery windows with explicit omissions. Overlapping sum, ended interval union, reporter horizon and command wall time are not CPU or exclusive causal costs.",
];
export const SUITE_ATTRIBUTION_LIMITATIONS: readonly string[] = Object.freeze([...attributionLimitations]);
function attributionUnavailable(deadline: ProfileDeadline, expired = false): SuiteAttributionDiagnosticReport {
  return { ...suiteUnavailableReport(deadline, expired), workload: "full-suite-attribution", progress: null, wait_receipt: null, costs: null, limitations: [...attributionLimitations] };
}
interface AttributionEvidence { progress: SuiteProgressSnapshot | null; costs: SuiteAttributionCosts | null }
function attributionDetach(value: unknown, depth = 0, budget = { remaining: 4096 }): unknown {
  if (--budget.remaining < 0 || depth > 8) throw new Error();
  if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.length <= 8192) return value;
  if (Array.isArray(value)) { if (!suiteArray(value, 256)) throw new Error(); const result: unknown[] = []; for (let index = 0; index < value.length; index++) result.push(attributionDetach(value[index], depth + 1, budget)); return result; }
  const data = suiteRecord(value, 32); if (!data) throw new Error();
  return Object.fromEntries(Object.entries(data).map(([key, entry]) => [key, attributionDetach(entry, depth + 1, budget)]));
}
function attributionWaitPassed(receipt: PlannerWaitReceipt | null): boolean {
  if (!receipt || receipt.capture_status !== "captured" || !receipt.checkpoints || !receipt.polls) return false;
  return ["callback-start", "attempt-enter", "attempt-return", "attempt-resolve", "executor-enter", "executor-body-return", "wait-enter", "wait-return", "capture"].every((key) => receipt.checkpoints![key as PlannerWaitCheckpoint] !== null)
    && ["attempt-sync-throw", "attempt-reject", "executor-body-throw", "wait-reject"].every((key) => receipt.checkpoints![key as PlannerWaitCheckpoint] === null)
    && receipt.polls.calls > 0 && receipt.polls.read_returns > 0 && receipt.polls.last_lifecycle === "finished";
}
/** The compact DTO cannot prove its omitted facts: full private evidence is mandatory. */
export function sanitizeSuiteAttributionDiagnostic(value: unknown, sourceLimits?: PlannerFailureSourceLimits | null, evidence?: AttributionEvidence): SuiteAttributionDiagnosticReport | null {
  try {
    const data = suiteExact(value, ["schema_version", "workload", "diagnostic_only", "acceptance", "status", "wall_ms", "wall_limit_ms", "cleanup_reserve_ms", "source_hashes", "source_hashes_after", "source_drift", "progress", "receipt", "wait_receipt", "costs", "json", "native_exit", "stdio_close", "last_progress_received_ms", "cleanup", "limitations"]);
    if (!data || data.workload !== "full-suite-attribution" || !suiteArray(data.limitations, attributionLimitations.length) || data.limitations.length !== attributionLimitations.length) return null;
    const limitations = attributionDetach(data.limitations) as unknown[]; if (limitations.some((line, index) => line !== attributionLimitations[index])) return null;
    const before = attributionHashes(data.source_hashes), after = attributionHashes(data.source_hashes_after);
    if (!before || !after || data.source_drift !== null && (Object.keys(before).length !== 19 || Object.keys(after).length !== 19 || sourceHashesChanged(before, after) !== data.source_drift)) return null;
    if (Object.keys(before).length === 19 && !SUITE_ATTRIBUTION_CONTRACT_HASHES.every((hash, index) => before[index < 5 ? SUITE_PROGRESS_SOURCES[11 + index]! : SUITE_ATTRIBUTION_SOURCES[18]] === hash)) return null;
    const privateEvidence = evidence === undefined ? null : suiteExact(evidence, ["progress", "costs"]); if (evidence !== undefined && !privateEvidence) return null;
    const full = privateEvidence?.progress === null || privateEvidence?.progress === undefined ? null : sanitizeSuiteProgressSnapshot(privateEvidence.progress), compact = compactSuiteProgress(full);
    if (privateEvidence?.progress !== null && privateEvidence?.progress !== undefined && !full) return null;
    const incomingCompact = data.progress === null ? null : suiteExact(attributionDetach(data.progress), ["availability", "unavailable_reason", "sequence", "reporter_elapsed_ms", "module_count", "observed_modules", "queued_modules", "collected_modules", "started_modules", "ended_modules", "counts", "open_case_count", "tail", "run_end", "planner_result"]);
    if (data.progress !== null && !incomingCompact || JSON.stringify(incomingCompact) !== JSON.stringify(compact)) return null;
    const costs = data.costs === null ? null : sanitizeSuiteAttributionCosts(data.costs), expectedCosts = privateEvidence?.costs === null || privateEvidence?.costs === undefined ? null : sanitizeSuiteAttributionCosts(privateEvidence.costs);
    if (privateEvidence?.costs !== null && privateEvidence?.costs !== undefined && !expectedCosts) return null;
    if (data.costs !== null && !costs || JSON.stringify(costs) !== JSON.stringify(expectedCosts) || (costs === null) !== (full === null) || costs && full && (costs.sequence !== full.sequence || costs.reporter_elapsed_ms !== full.reporter_elapsed_ms || costs.module_count !== full.module_count || costs.observed_modules !== full.modules.length || costs.availability !== full.availability)) return null;
    const wait = data.wait_receipt === null ? null : sanitizePlannerWaitReceipt(data.wait_receipt); if (data.wait_receipt !== null && !wait) return null;
    // Reconstruct only the original sixteen-source contract, never broaden its dictionary.
    const oldInput = { schema_version: data.schema_version, workload: "full-suite-progress", diagnostic_only: data.diagnostic_only, acceptance: data.acceptance, status: data.status, wall_ms: data.wall_ms, wall_limit_ms: data.wall_limit_ms, cleanup_reserve_ms: data.cleanup_reserve_ms,
      source_hashes: attributionOriginalHashes(before), source_hashes_after: attributionOriginalHashes(after), source_drift: data.source_drift === null ? null : sourceHashesChanged(attributionOriginalHashes(before), attributionOriginalHashes(after)), progress: full, receipt: data.receipt, json: data.json, native_exit: data.native_exit, stdio_close: data.stdio_close, last_progress_received_ms: data.last_progress_received_ms, cleanup: data.cleanup, limitations: [...suiteProgressLimitations] };
    const old = sanitizeSuiteProgressDiagnostic(oldInput, sourceLimits); if (!old) return null;
    const report: SuiteAttributionDiagnosticReport = { ...old, workload: "full-suite-attribution", source_hashes: before, source_hashes_after: after, source_drift: data.source_drift as boolean | null, progress: compact, wait_receipt: wait, costs, limitations: [...attributionLimitations] };
    if (report.status === "completed" && (Object.keys(before).length !== 19 || report.source_drift !== false || !attributionWaitPassed(wait) || costs?.availability !== "available" || costs.ended?.eligible_count !== full?.modules.length || costs.start_without_end?.eligible_count !== 0)) return null;
    return suiteBoundedJson(report) && Buffer.byteLength(JSON.stringify({ role: "suite-attribution-report", report })) <= SUITE_PROGRESS_LIMITS.snapshot_bytes ? report : null;
  } catch { return null; }
}

async function runLoadedSuiteAttribution(deadline: ProfileDeadline, metadata: (source: SuiteAttributionSourceMetadata) => void, delta: (message: unknown) => void): Promise<SuiteAttributionDiagnosticReport> {
  const report = attributionUnavailable(deadline); let receiptSeen = false, receiptRevoked = false, waitSeen = false, waitRevoked = false;
  try {
    report.source_hashes = sourceHashes(SUITE_ATTRIBUTION_SOURCES);
    const fixture = preparePlannerFailureSourceMetadata(); if (!fixture) return report;
    const source = sanitizeSuiteAttributionSourceMetadata({ role: "suite-attribution-source", fixture_sha256: fixture.fixture_sha256, sourceLimits: fixture.sourceLimits, source_hashes: report.source_hashes });
    if (!source) return report; metadata(source);
    const before = prefixInventory("surtec-workflow-worker-"); if (!deadline.mayLaunch()) { report.status = "deadline"; return report; }
    const costs = createSuiteAttributionCosts();
    const collector = createSuiteProgressCollector(undefined, (frame) => { costs.accept(frame); const received_ms = deadline.elapsed(); if (!spanTime(received_ms)) return; report.last_progress_received_ms = received_ms; delta({ role: "suite-attribution-frame", frame, received_ms }); });
    const revokeReceipt = () => { if (!receiptRevoked) { receiptRevoked = true; report.receipt = null; delta({ role: "suite-attribution-receipt-unavailable" }); } };
    const spans = createPlannerSpanMarkerCollector((receipt) => { if (!receipt || receiptSeen) { revokeReceipt(); return; } receiptSeen = true; if (!receiptRevoked) { report.receipt = receipt; delta({ role: "suite-attribution-receipt", receipt, received_ms: deadline.elapsed() }); } }, source.sourceLimits);
    const revokeWait = () => { if (!waitRevoked) { waitRevoked = true; report.wait_receipt = null; delta({ role: "suite-attribution-wait-unavailable" }); } };
    let output = "", invalid = false; const decoder = new TextDecoder("utf-8", { fatal: true });
    const wait = createPlannerWaitMarkerCollector((receipt) => { if (!receipt || waitSeen) { revokeWait(); return; } waitSeen = true; if (!waitRevoked) { report.wait_receipt = receipt; delta({ role: "suite-attribution-wait", receipt, received_ms: deadline.elapsed() }); } }, (chunk) => { try { output += decoder.decode(chunk, { stream: true }); } catch { invalid = true; } });
    const child = spawn(process.execPath, suiteAttributionArguments(), { cwd: repository, env: suiteAttributionEnvironment(process.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.once("exit", (code, signal) => { const observation = suiteExit({ code, signal: signal === null ? null : signal === "SIGTERM" || signal === "SIGKILL" ? signal : "other", received_ms: deadline.elapsed() }); if (observation) { report.native_exit = observation; try { delta({ role: "suite-attribution-exit", native_exit: observation }); } catch { /* Missing delivery remains unknown. */ } } });
    const pending = superviseChild(child, deadline);
    child.stdout?.on("data", (chunk: Buffer) => { spans.push(chunk); wait.push(chunk); }); child.stderr?.on("data", (chunk: Buffer) => collector.push(chunk));
    const outcome = await pending; report.stdio_close = outcome;
    const full = collector.finish(); if (full?.availability === "unavailable") costs.revoke(); report.progress = compactSuiteProgress(full); report.costs = costs.snapshot();
    const spanReceipt = spans.finish(); if (receiptSeen && !spanReceipt) revokeReceipt(); report.receipt = receiptRevoked ? null : spanReceipt;
    const waitReceipt = wait.finish(); if (!wait.valid()) revokeWait(); report.wait_receipt = waitRevoked ? null : waitReceipt;
    try { output += decoder.decode(); } catch { invalid = true; }
    if (!invalid && wait.valid() && outcome.closed && full) report.json = summarizeSuiteProgressJson(output, full, collector.reconcile);
    report.status = outcome.expired ? "deadline" : "failed";
    const normal = outcome.closed && !outcome.expired && !outcome.failed && outcome.exit_code === 0 && report.native_exit?.code === 0 && report.native_exit.signal === null && !invalid && wait.valid();
    if (normal && report.json?.passed && report.json.first_planner?.passed && [...prefixInventory("surtec-workflow-worker-")].every((name) => before.has(name))) report.cleanup = "verified-normal-suite-and-no-new-planner-prefix-roots";
    if (deadline.remaining() > 0) { report.source_hashes_after = sourceHashes(SUITE_ATTRIBUTION_SOURCES); report.source_drift = sourceHashesChanged(report.source_hashes, report.source_hashes_after); }
    report.wall_ms = deadline.elapsed();
    const evidence = { progress: full, costs: report.costs }, completed = sanitizeSuiteAttributionDiagnostic({ ...report, status: "completed" }, source.sourceLimits, evidence);
    if (completed) report.status = "completed";
    const safe = sanitizeSuiteAttributionDiagnostic(report, source.sourceLimits, evidence); if (!safe) throw new Error(); return safe;
  } catch { report.status = deadline.remaining() <= 0 ? "deadline" : "failed"; }
  report.wall_ms = deadline.elapsed(); if (deadline.remaining() <= 0) { report.status = "deadline"; report.cleanup = "unavailable-no-uncertain-fixture-deleted"; } return report;
}
interface AttributionControllerChild extends SupervisedChild { on(event: "message", listener: (value: unknown) => void): unknown; send(message: { role: "suite-attribution-controller"; origin_ms: number }): unknown }
/** Filesystem-free: the issued controller's deltas are independently revalidated. */
export async function runSuiteAttributionDiagnosticWatchdog(deadline = new ProfileDeadline(), launch: () => AttributionControllerChild = () => fork(script, [], { cwd: repository, execArgv: ["--import", "tsx"], env: profileEnvironment(process.env), stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true })): Promise<SuiteAttributionDiagnosticReport> {
  if (!deadline.mayLaunch()) return attributionUnavailable(deadline, true);
  const projection = createSuiteProgressProjection(), costs = createSuiteAttributionCosts();
  let source: SuiteAttributionSourceMetadata | null = null, sourceSeen = false, finalSeen = false, revoked = false, final: SuiteAttributionDiagnosticReport | null = null;
  let receipt: PlannerSpanReceipt | null = null, wait: PlannerWaitReceipt | null = null, receiptSeen = false, waitSeen = false, receiptRevoked = false, waitRevoked = false;
  let exit: SuiteProgressDiagnosticReport["native_exit"] = null, received: number | null = null, lastDelivery = 0, messages = 0, bytes = 0;
  const unavailable = (expired: boolean) => { const report = attributionUnavailable(deadline, expired); if (!revoked) { report.source_hashes = source?.source_hashes ?? {}; report.progress = compactSuiteProgress(projection.snapshot()); report.costs = costs.snapshot(); report.last_progress_received_ms = report.progress ? received : null; report.receipt = receipt; report.wait_receipt = wait; report.native_exit = exit; } return report; };
  try {
    const controller = launch(), cancellation = new AbortController(), pending = superviseChild(controller, deadline, 1000, cancellation.signal, "cleanup");
    controller.stdout?.on?.("data", () => {}); controller.stderr?.on?.("data", () => {});
    controller.on("message", (value) => {
      if (revoked) return;
      try {
        const data = suiteRecord(value, 4); if (!data || finalSeen || ++messages > 50008) { revoked = true; return; }
        if (data.role === "suite-attribution-source") { if (sourceSeen) { revoked = true; return; } sourceSeen = true; source = sanitizeSuiteAttributionSourceMetadata(value); if (!source) { revoked = true; return; } bytes += Buffer.byteLength(JSON.stringify(source)); return; }
        if (!source) { revoked = true; return; }
        if (data.role === "suite-attribution-frame" || data.role === "suite-attribution-receipt" || data.role === "suite-attribution-wait") {
          const frameKind = data.role === "suite-attribution-frame", keys = frameKind ? ["role", "frame", "received_ms"] : ["role", "receipt", "received_ms"];
          if (!suiteExact(value, keys) || !spanTime(data.received_ms) || data.received_ms < lastDelivery || data.received_ms > deadline.elapsed()) { revoked = true; return; }
          lastDelivery = data.received_ms;
          if (frameKind) { const frame = sanitizeSuiteProgressFrame(data.frame); if (!frame || !projection.accept(frame) || !costs.accept(frame)) { revoked = true; return; } received = data.received_ms; bytes += Buffer.byteLength(JSON.stringify(frame)) + 128; }
          else if (data.role === "suite-attribution-receipt") { if (receiptSeen || receiptRevoked) { revoked = true; return; } receiptSeen = true; receipt = sanitizePlannerSpanReceipt(data.receipt, source.sourceLimits); if (!receipt) { revoked = true; return; } bytes += Buffer.byteLength(JSON.stringify(receipt)) + 128; }
          else { if (waitSeen || waitRevoked) { revoked = true; return; } waitSeen = true; wait = sanitizePlannerWaitReceipt(data.receipt); if (!wait) { revoked = true; return; } bytes += Buffer.byteLength(JSON.stringify(wait)) + 128; }
        } else if (data.role === "suite-attribution-receipt-unavailable" || data.role === "suite-attribution-wait-unavailable") {
          if (!suiteExact(value, ["role"])) { revoked = true; return; }
          if (data.role === "suite-attribution-receipt-unavailable") { if (receiptRevoked) { revoked = true; return; } receiptRevoked = true; receipt = null; } else { if (waitRevoked) { revoked = true; return; } waitRevoked = true; wait = null; } bytes += 128;
        } else if (data.role === "suite-attribution-exit") { if (!suiteExact(value, ["role", "native_exit"]) || exit) { revoked = true; return; } exit = suiteExit(data.native_exit); if (!exit || exit.received_ms < lastDelivery || exit.received_ms > deadline.elapsed()) { revoked = true; return; } lastDelivery = exit.received_ms; bytes += 256; }
        else if (data.role === "suite-attribution-report") {
          if (!suiteExact(value, ["role", "report"])) { revoked = true; return; } finalSeen = true;
          const report = sanitizeSuiteAttributionDiagnostic(data.report, source.sourceLimits, { progress: projection.snapshot(), costs: costs.snapshot() });
          if (!report || report.wall_ms < lastDelivery || report.wall_ms > deadline.elapsed() || sourceHashesChanged(source.source_hashes, report.source_hashes) || JSON.stringify(report.receipt) !== JSON.stringify(receipt) || JSON.stringify(report.wait_receipt) !== JSON.stringify(wait) || JSON.stringify(report.native_exit) !== JSON.stringify(exit) || report.last_progress_received_ms !== received) { revoked = true; return; }
          final = report; bytes += Buffer.byteLength(JSON.stringify(report));
        } else { revoked = true; return; }
        if (bytes > SUITE_PROGRESS_LIMITS.stderr_bytes + 2 * SUITE_PROGRESS_LIMITS.snapshot_bytes + 50000 * 128) revoked = true;
      } catch { revoked = true; }
    });
    try { controller.send({ role: "suite-attribution-controller", origin_ms: performance.timeOrigin }); } catch { cancellation.abort(); }
    const outcome = await pending, report = final as SuiteAttributionDiagnosticReport | null;
    if (revoked || !outcome.closed || outcome.expired || outcome.failed || outcome.exit_code !== 0 || !report || deadline.remaining() <= 0) return unavailable(outcome.expired || deadline.remaining() <= 0);
    report.wall_ms = deadline.elapsed(); return report;
  } catch { return unavailable(deadline.remaining() <= 0); }
}
async function suiteAttributionControllerWorker(value: unknown): Promise<void> {
  try {
    const data = suiteExact(value, ["role", "origin_ms"]); if (!data || data.role !== "suite-attribution-controller" || !finite(data.origin_ms)) throw new Error();
    const origin = data.origin_ms, deadline = new ProfileDeadline(() => performance.timeOrigin + performance.now() - origin); let deliveryUnavailable = false;
    const send = (message: unknown): void => { if (deliveryUnavailable || !process.send || !process.connected) throw new Error(); const queued = process.send(message, (error) => { if (error) deliveryUnavailable = true; }); if (!queued) { deliveryUnavailable = true; throw new Error(); } };
    const report = await runLoadedSuiteAttribution(deadline, send, (message) => { try { send(message); } catch { deliveryUnavailable = true; } });
    if (deliveryUnavailable || !process.send || !process.connected) throw new Error();
    process.send({ role: "suite-attribution-report", report }, (error) => { if (process.connected) process.disconnect(); process.exitCode = error ? 1 : 0; });
  } catch { if (process.connected) process.disconnect(); process.exitCode = 1; }
}

/** Process age includes loader/static imports; one budget is shared by every child. */
// P12 derives target case delivery windows without changing the P10 reporter.
export interface WorkflowCaseEndedWindow { ordinal: number; alias: SuiteProgressCase["alias"]; state: SuiteProgressState; original_attempt: SuiteProgressAttempt | null; start_ms: number; end_ms: number; elapsed_ms: number }
export interface WorkflowCaseOpenWindow { ordinal: number; alias: SuiteProgressCase["alias"]; start_ms: number; horizon_ms: number; elapsed_ms: number }
export interface WorkflowCaseGap { ordinal: number; start_ms: number; end_ms: number; elapsed_ms: number }
export interface WorkflowTimingRanking<T> { eligible_count: number; retained_count: number; omitted_count: number; top: T[] }
export interface WorkflowCaseTiming {
  schema_version: 1; availability: "available" | "unavailable"; unavailable_reason: SuiteProgressSnapshot["unavailable_reason"] | "invalid-window";
  sequence: number; reporter_elapsed_ms: number | null; module: SuiteProgressModule | null;
  window: { start_ms: number | null; end_ms: number | null; horizon_ms: number | null; state: SuiteProgressState | null } | null;
  counts: { collected: number | null; paired: number; open: number; unpaired: number; unobserved: number | null } | null;
  ended: WorkflowTimingRanking<WorkflowCaseEndedWindow> | null;
  coverage: { union_ms: number; complement_ms: number; gaps: WorkflowTimingRanking<WorkflowCaseGap> } | null;
  open: WorkflowTimingRanking<WorkflowCaseOpenWindow> | null;
}
const workflowTargetSource = "runner/workflow-orchestrator.test.ts";
function workflowRanking<T extends { ordinal: number; elapsed_ms: number }>(rows: T[], cap: number): WorkflowTimingRanking<T> {
  return { eligible_count: rows.length, retained_count: Math.min(rows.length, cap), omitted_count: Math.max(0, rows.length - cap), top: [...rows].sort((a, b) => b.elapsed_ms - a.elapsed_ms || a.ordinal - b.ordinal).slice(0, cap) };
}
function workflowRank(value: unknown, cap: number, maximum: number, row: (value: unknown) => unknown): boolean {
  const data = suiteExact(value, ["eligible_count", "retained_count", "omitted_count", "top"]);
  return !!data && suiteInteger(data.eligible_count, maximum) && data.retained_count === Math.min(data.eligible_count, cap) && data.omitted_count === data.eligible_count - (data.retained_count as number)
    && suiteArray(data.top, cap) && data.top.length === data.retained_count && data.top.every((item) => !!row(item)) && suiteCostRanking(data.top as Array<{ ordinal: number; elapsed_ms: number }>)
    && new Set((data.top as Array<{ ordinal: number }>).map((item) => item.ordinal)).size === data.top.length;
}
export function sanitizeWorkflowCaseTiming(value: unknown): WorkflowCaseTiming | null {
  try {
    const data = suiteExact(value, ["schema_version", "availability", "unavailable_reason", "sequence", "reporter_elapsed_ms", "module", "window", "counts", "ended", "coverage", "open"]);
    if (!data || data.schema_version !== 1 || !suiteInteger(data.sequence, 50000, 1) || data.reporter_elapsed_ms !== null && !spanTime(data.reporter_elapsed_ms)) return null;
    const binding = data.module === null ? null : suiteModule(data.module);
    if (data.module !== null && (!binding || binding.source !== workflowTargetSource)) return null;
    if (data.availability === "unavailable") {
      if (![...suiteReasons, "invalid-transport", "invalid-window"].includes(data.unavailable_reason as never) || ["window", "counts", "ended", "coverage", "open"].some((key) => data[key] !== null)) return null;
    } else if (data.availability !== "available" || data.unavailable_reason !== null) return null;
    else if (!binding) { if (["window", "counts", "ended", "coverage", "open"].some((key) => data[key] !== null)) return null; }
    else {
      const window = suiteExact(data.window, ["start_ms", "end_ms", "horizon_ms", "state"]), counts = suiteExact(data.counts, ["collected", "paired", "open", "unpaired", "unobserved"]);
      if (!window || !counts || !["start_ms", "end_ms", "horizon_ms"].every((key) => window[key] === null || spanTime(window[key])) || window.state !== null && !(suiteStates as readonly unknown[]).includes(window.state)) return null;
      if (window.end_ms !== null && (window.start_ms === null || (window.end_ms as number) < (window.start_ms as number) || window.state === null) || window.end_ms === null && window.state !== null || window.horizon_ms !== (window.start_ms === null ? null : window.end_ms ?? data.reporter_elapsed_ms)) return null;
      if (window.start_ms !== null && (window.horizon_ms === null || (window.start_ms as number) > (window.horizon_ms as number)) || window.horizon_ms !== null && (data.reporter_elapsed_ms === null || (window.horizon_ms as number) > (data.reporter_elapsed_ms as number))) return null;
      if (!["paired", "open", "unpaired"].every((key) => suiteInteger(counts[key], key === "open" ? 64 : 20000))) return null;
      const observed = (counts.paired as number) + (counts.open as number) + (counts.unpaired as number);
      if (observed > 20000 || (counts.collected === null ? counts.unobserved !== null : !suiteInteger(counts.collected, 20000) || counts.unobserved !== counts.collected - observed || !suiteInteger(counts.unobserved, 20000))) return null;
      const identity = (row: Record<string, unknown>) => suiteInteger(row.ordinal, 20000, 1) && (row.alias === null || row.alias === "first-implementation-planner");
      const interval = (row: Record<string, unknown>, end: "end_ms" | "horizon_ms") => spanTime(row.start_ms) && spanTime(row[end]) && spanTime(row.elapsed_ms) && row.elapsed_ms === (row[end] as number) - row.start_ms && window.start_ms !== null && row.start_ms >= (window.start_ms as number) && (row[end] as number) <= (window.horizon_ms as number);
      const endedRow = (input: unknown) => { const row = suiteExact(input, ["ordinal", "alias", "state", "original_attempt", "start_ms", "end_ms", "elapsed_ms"]); return row && identity(row) && interval(row, "end_ms") && (suiteStates as readonly unknown[]).includes(row.state) && (row.alias === null ? row.original_attempt === null : (suiteAttempts as readonly unknown[]).includes(row.original_attempt)); };
      const openRow = (input: unknown) => { const row = suiteExact(input, ["ordinal", "alias", "start_ms", "horizon_ms", "elapsed_ms"]); return row && identity(row) && interval(row, "horizon_ms") && row.horizon_ms === window.horizon_ms; };
      if (!workflowRank(data.ended, 16, 20000, endedRow) || !workflowRank(data.open, 4, 64, openRow) || (data.ended as WorkflowTimingRanking<WorkflowCaseEndedWindow>).eligible_count !== counts.paired || (data.open as WorkflowTimingRanking<WorkflowCaseOpenWindow>).eligible_count !== counts.open) return null;
      if (window.start_ms === null) { if (data.coverage !== null || counts.paired !== 0 || counts.open !== 0) return null; }
      else {
        const coverage = suiteExact(data.coverage, ["union_ms", "complement_ms", "gaps"]), width = (window.horizon_ms as number) - (window.start_ms as number);
        if (!coverage || !spanTime(coverage.union_ms) || !spanTime(coverage.complement_ms) || coverage.union_ms + coverage.complement_ms !== width) return null;
        const gapData = suiteExact(coverage.gaps, ["eligible_count", "retained_count", "omitted_count", "top"]); if (!gapData || !suiteInteger(gapData.eligible_count, 20001)) return null;
        const gapRow = (input: unknown) => { const row = suiteExact(input, ["ordinal", "start_ms", "end_ms", "elapsed_ms"]); return row && suiteInteger(row.ordinal, gapData.eligible_count as number, 1) && interval(row, "end_ms") && (row.elapsed_ms as number) > 0; };
        if (!workflowRank(coverage.gaps, 4, 20001, gapRow)) return null;
        const gaps = coverage.gaps as WorkflowTimingRanking<WorkflowCaseGap>, sorted = [...gaps.top].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || a.ordinal - b.ordinal);
        if (sorted.some((row, index) => index > 0 && (sorted[index - 1]!.end_ms > row.start_ms || sorted[index - 1]!.ordinal >= row.ordinal)) || gaps.top.reduce((sum, row) => sum + row.elapsed_ms, 0) > coverage.complement_ms || (gaps.eligible_count === 0) !== (coverage.complement_ms === 0)) return null;
      }
    }
    return suiteBoundedJson(data) ? attributionDetach(data) as WorkflowCaseTiming : null;
  } catch { return null; }
}
/** Full private roster is retained here; top-N samples are never replay evidence. */
export function createWorkflowCaseTimingProjection() {
  const projection = createSuiteProgressProjection(), cases = new Map<number, { ordinal: number; alias: SuiteProgressCase["alias"]; start: number | null; end: number | null; state: SuiteProgressState | null; attempt: SuiteProgressAttempt | null }>();
  let sequence = 0, horizon: number | null = null, target: SuiteProgressModule | null = null, start: number | null = null, end: number | null = null, state: SuiteProgressState | null = null, collected: number | null = null, reason: WorkflowCaseTiming["unavailable_reason"] = null;
  const revoke = (why: WorkflowCaseTiming["unavailable_reason"] = "invalid-transport") => { reason ??= why; projection.revoke(); };
  return {
    accept(input: unknown): boolean {
      if (reason) return false;
      const frame = sanitizeSuiteProgressFrame(input); if (!frame || !projection.accept(frame)) { revoke(); return false; }
      sequence = frame.sequence;
      if (frame.event === "observer-unavailable") { revoke(frame.data.reason); return true; }
      horizon = frame.reporter_elapsed_ms;
      if (frame.module?.source !== workflowTargetSource) return true;
      target = { ...frame.module };
      if (frame.event === "module-start") start = frame.reporter_elapsed_ms;
      if (frame.event === "module-end") { end = frame.reporter_elapsed_ms; state = frame.data.state; }
      if (frame.event === "module-collected") collected = frame.data.case_count;
      if (frame.case) {
        let row = cases.get(frame.case.ordinal);
        if (!row) { row = { ...frame.case, start: null, end: null, state: null, attempt: null }; cases.set(row.ordinal, row); }
        if (frame.event === "case-ready") row.start = frame.reporter_elapsed_ms;
        if (frame.event === "case-result") { row.end = frame.reporter_elapsed_ms; row.state = frame.data.state; row.attempt = frame.data.original_attempt; }
      }
      return true;
    },
    revoke,
    snapshot(): WorkflowCaseTiming | null {
      if (!sequence) return null;
      const unavailable = (): WorkflowCaseTiming => ({ schema_version: 1, availability: "unavailable", unavailable_reason: reason ?? "invalid-window", sequence, reporter_elapsed_ms: horizon, module: target ? { ...target } : null, window: null, counts: null, ended: null, coverage: null, open: null });
      if (reason) return unavailable();
      const base: WorkflowCaseTiming = { schema_version: 1, availability: "available", unavailable_reason: null, sequence, reporter_elapsed_ms: horizon, module: target ? { ...target } : null, window: null, counts: null, ended: null, coverage: null, open: null };
      if (!target) return base;
      const at = start === null ? null : end ?? horizon;
      base.window = { start_ms: start, end_ms: end, horizon_ms: at, state };
      const ended: WorkflowCaseEndedWindow[] = [], open: WorkflowCaseOpenWindow[] = []; let unpaired = 0;
      for (const row of cases.values()) {
        if (row.start !== null && row.end !== null) ended.push({ ordinal: row.ordinal, alias: row.alias, state: row.state!, original_attempt: row.attempt, start_ms: row.start, end_ms: row.end, elapsed_ms: row.end - row.start });
        else if (row.start !== null) open.push({ ordinal: row.ordinal, alias: row.alias, start_ms: row.start, horizon_ms: at!, elapsed_ms: at! - row.start });
        else if (row.end !== null) unpaired++;
      }
      base.counts = { collected, paired: ended.length, open: open.length, unpaired, unobserved: collected === null ? null : collected - ended.length - open.length - unpaired };
      base.ended = workflowRanking(ended, 16); base.open = workflowRanking(open, 4);
      if (start !== null && at !== null) {
        let through = start, union = 0; const gaps: WorkflowCaseGap[] = [];
        const addGap = (a: number, b: number) => { if (b > a) gaps.push({ ordinal: gaps.length + 1, start_ms: a, end_ms: b, elapsed_ms: b - a }); };
        for (const row of [...ended].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || a.ordinal - b.ordinal)) {
          if (row.start_ms < start || row.end_ms > at || row.end_ms < row.start_ms) { revoke("invalid-window"); return unavailable(); }
          if (row.start_ms > through) addGap(through, row.start_ms);
          if (row.end_ms > through) { union += row.end_ms - Math.max(through, row.start_ms); through = row.end_ms; }
        }
        addGap(through, at); const complement = gaps.reduce((sum, row) => sum + row.elapsed_ms, 0);
        base.coverage = { union_ms: union, complement_ms: complement, gaps: workflowRanking(gaps, 4) };
      }
      const safe = sanitizeWorkflowCaseTiming(base); if (!safe) { revoke("invalid-window"); return unavailable(); } return safe;
    },
  };
}

export interface WorkflowTimingOutputCallbacks {
  span?(receipt: PlannerSpanReceipt): void; wait?(receipt: PlannerWaitReceipt): void; continuity?(receipt: PlannerContinuityReceipt): void; data?(chunk: Buffer): void; revoke?(): void;
}
/** One original-byte budget and one permanent revocation for the three receipts. */
export function createWorkflowTimingOutputCollector(callbacks: WorkflowTimingOutputCallbacks = {}, sourceLimits: PlannerFailureSourceLimits | null = null) {
  const prefixes = [Buffer.from(PLANNER_WAIT_MARKER), Buffer.from(PLANNER_CONTINUITY_MARKER)], decoder = new TextDecoder("utf-8", { fatal: true });
  let receipt: PlannerSpanReceipt | null = null, wait_receipt: PlannerWaitReceipt | null = null, continuity_receipt: PlannerContinuityReceipt | null = null;
  let spanSeen = false, waitSeen = false, continuitySeen = false, invalid = false, finished = false, total = 0, line: number[] = [], streaming = false;
  const revoke = () => { if (!invalid) { invalid = true; receipt = null; wait_receipt = null; continuity_receipt = null; try { callbacks.revoke?.(); } catch { /* The family remains revoked. */ } } };
  const forward = (bytes: Buffer) => { if (bytes.length) try { callbacks.data?.(Buffer.from(bytes)); } catch { revoke(); } };
  const spans = createPlannerSpanMarkerCollector((value) => { if (!value || spanSeen) { revoke(); return; } spanSeen = true; if (!invalid) { receipt = value; try { callbacks.span?.(value); } catch { revoke(); } } }, sourceLimits);
  const isReserved = (bytes: Buffer) => prefixes.some((prefix) => bytes.length > 0 && bytes.subarray(0, Math.min(bytes.length, prefix.length - 1)).equals(prefix.subarray(0, Math.min(bytes.length, prefix.length - 1))));
  const processLine = () => {
    const bytes = Buffer.from(line), index = prefixes.findIndex((prefix) => bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix));
    if (index < 0) { if (isReserved(bytes.subarray(0, bytes.length - 1))) revoke(); forward(bytes); }
    else {
      let parsed: PlannerWaitReceipt | PlannerContinuityReceipt | null = null;
      if (bytes.length <= 8192) try { const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(prefixes[index]!.length, bytes.length - 1)), value = suiteParseJson(raw); parsed = index === 0 ? sanitizePlannerWaitReceipt(value) : sanitizePlannerContinuityReceipt(value); } catch { /* Preserve malformed original bytes below. */ }
      const duplicate = index === 0 ? waitSeen : continuitySeen;
      if (index === 0) waitSeen = true; else continuitySeen = true;
      if (!parsed || duplicate || invalid) { revoke(); forward(bytes); }
      else try {
        if (index === 0) { wait_receipt = parsed as PlannerWaitReceipt; callbacks.wait?.(wait_receipt); }
        else { continuity_receipt = parsed as PlannerContinuityReceipt; callbacks.continuity?.(continuity_receipt); }
      } catch { revoke(); forward(bytes); }
    }
    line = []; streaming = false;
  };
  return Object.freeze({
    push(chunk: Buffer | string): void {
      if (finished || typeof chunk !== "string" && (!Buffer.isBuffer(chunk) || nodeTypes.isProxy(chunk))) { revoke(); return; }
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk; total += bytes.length;
      if (total > OUTPUT_LIMIT) { revoke(); return; }
      try { decoder.decode(bytes, { stream: true }); } catch { revoke(); }
      spans.push(bytes);
      for (let index = 0; index < bytes.length; index++) {
        if (streaming) { const end = bytes.indexOf(10, index); forward(bytes.subarray(index, end < 0 ? bytes.length : end + 1)); if (end < 0) break; index = end; streaming = false; continue; }
        const byte = bytes[index]!; line.push(byte);
        if (byte === 10) { processLine(); continue; }
        const matching = prefixes.some((prefix) => prefix.subarray(0, Math.min(line.length, prefix.length)).every((value, offset) => line[offset] === value));
        if (!matching || line.length >= 8192) { const buffer = Buffer.from(line); if (isReserved(buffer)) revoke(); forward(buffer); line = []; streaming = true; }
      }
    },
    finish(): { receipt: PlannerSpanReceipt | null; wait_receipt: PlannerWaitReceipt | null; continuity_receipt: PlannerContinuityReceipt | null } {
      if (!finished) {
        finished = true; const parsed = spans.finish(); if (spanSeen && !parsed) revoke();
        try { decoder.decode(); } catch { revoke(); }
        if (line.length) { const buffer = Buffer.from(line); if (isReserved(buffer)) revoke(); forward(buffer); line = []; }
      }
      return { receipt, wait_receipt, continuity_receipt };
    },
    valid(): boolean { return !invalid; },
  });
}
export function createPlannerContinuityOutputCollector(onReceipt: (receipt: PlannerContinuityReceipt | null) => void = () => {}, onData: (chunk: Buffer) => void = () => {}) {
  const collector = createWorkflowTimingOutputCollector({ continuity: onReceipt, data: onData, revoke: () => onReceipt(null) });
  return Object.freeze({ push: collector.push, finish: () => collector.finish().continuity_receipt, valid: collector.valid });
}

export const SUITE_WORKFLOW_TIMING_SOURCES = Object.freeze([...SUITE_ATTRIBUTION_SOURCES, "runner/workflow-orchestrator.ts"] as const);
export const SUITE_WORKFLOW_TIMING_CONTRACT_HASHES: readonly string[] = Object.freeze([...SUITE_ATTRIBUTION_CONTRACT_HASHES]);
export interface SuiteWorkflowTimingSourceMetadata { role: "suite-workflow-timing-source"; fixture_sha256: string; sourceLimits: PlannerFailureSourceLimits; source_hashes: Record<string, string> }
function workflowTimingHashes(value: unknown, complete = false): Record<string, string> | null {
  const input = suiteRecord(value, 20); if (!input || complete && Object.keys(input).length !== 20) return null;
  const result: Record<string, string> = {};
  for (const [key, hash] of Object.entries(input)) { if (!(SUITE_WORKFLOW_TIMING_SOURCES as readonly string[]).includes(key) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return null; result[key] = hash; }
  return result;
}
function workflowTimingOriginalHashes(hashes: Record<string, string>): Record<string, string> { return Object.fromEntries(SUITE_ATTRIBUTION_SOURCES.filter((source) => Object.hasOwn(hashes, source)).map((source) => [source, hashes[source]!])); }
export function sanitizeSuiteWorkflowTimingSourceMetadata(value: unknown): SuiteWorkflowTimingSourceMetadata | null {
  try {
    const data = suiteExact(value, ["role", "fixture_sha256", "sourceLimits", "source_hashes"]); if (!data || data.role !== "suite-workflow-timing-source") return null;
    const hashes = workflowTimingHashes(data.source_hashes, true); if (!hashes) return null;
    const original = sanitizeSuiteAttributionSourceMetadata({ role: "suite-attribution-source", fixture_sha256: data.fixture_sha256, sourceLimits: data.sourceLimits, source_hashes: workflowTimingOriginalHashes(hashes) });
    return original ? { role: "suite-workflow-timing-source", fixture_sha256: original.fixture_sha256, sourceLimits: original.sourceLimits, source_hashes: hashes } : null;
  } catch { return null; }
}
export function suiteWorkflowTimingArguments(): string[] { return suiteAttributionArguments(); }
export function suiteWorkflowTimingEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv { return { ...suiteAttributionEnvironment(source), SURTEC_TEST_PLANNER_CONTINUITY_PROFILE: "1" }; }
export interface SuiteWorkflowTimingDiagnosticReport extends Omit<SuiteAttributionDiagnosticReport, "workload"> {
  workload: "full-suite-workflow-timing"; workflow_cases: WorkflowCaseTiming | null; continuity_receipt: PlannerContinuityReceipt | null;
}
const workflowTimingLimitations = [...attributionLimitations,
  "P12 case windows and their union/complement describe inclusive reporter delivery, not callback, CPU, idle, setup or cleanup attribution; batching and strict IEEE arithmetic can hide work or make measurements unavailable.",
  "P12 observes only original synchronous poll bodies and the exact fixture controller before sealing. Native attempt settlement, controller return, timer-mode/aborted booleans and terminal persistence are distinct; no post-stop continuation or scheduling cause is proved.",
];
export const SUITE_WORKFLOW_TIMING_LIMITATIONS: readonly string[] = Object.freeze([...workflowTimingLimitations]);
function workflowTimingUnavailable(deadline: ProfileDeadline, expired = false): SuiteWorkflowTimingDiagnosticReport { return { ...attributionUnavailable(deadline, expired), workload: "full-suite-workflow-timing", workflow_cases: null, continuity_receipt: null, limitations: [...workflowTimingLimitations] }; }
interface WorkflowTimingEvidence extends AttributionEvidence { workflow_cases: WorkflowCaseTiming | null }
export function sanitizeSuiteWorkflowTimingDiagnostic(value: unknown, sourceLimits?: PlannerFailureSourceLimits | null, evidence?: WorkflowTimingEvidence): SuiteWorkflowTimingDiagnosticReport | null {
  try {
    const data = suiteExact(value, ["schema_version", "workload", "diagnostic_only", "acceptance", "status", "wall_ms", "wall_limit_ms", "cleanup_reserve_ms", "source_hashes", "source_hashes_after", "source_drift", "progress", "receipt", "wait_receipt", "costs", "workflow_cases", "continuity_receipt", "json", "native_exit", "stdio_close", "last_progress_received_ms", "cleanup", "limitations"]);
    if (!data || data.workload !== "full-suite-workflow-timing" || !suiteArray(data.limitations, workflowTimingLimitations.length) || JSON.stringify(attributionDetach(data.limitations)) !== JSON.stringify(workflowTimingLimitations)) return null;
    const before = workflowTimingHashes(data.source_hashes), after = workflowTimingHashes(data.source_hashes_after);
    if (!before || !after || data.source_drift !== null && (Object.keys(before).length !== 20 || Object.keys(after).length !== 20 || sourceHashesChanged(before, after) !== data.source_drift)) return null;
    const privateEvidence = evidence === undefined ? null : suiteExact(evidence, ["progress", "costs", "workflow_cases"]); if (evidence !== undefined && !privateEvidence) return null;
    const cases = data.workflow_cases === null ? null : sanitizeWorkflowCaseTiming(data.workflow_cases), expected = privateEvidence?.workflow_cases === null || privateEvidence?.workflow_cases === undefined ? null : sanitizeWorkflowCaseTiming(privateEvidence.workflow_cases);
    if (data.workflow_cases !== null && !cases || privateEvidence?.workflow_cases != null && !expected || JSON.stringify(cases) !== JSON.stringify(expected)) return null;
    const originalInput = { schema_version: data.schema_version, workload: "full-suite-attribution", diagnostic_only: data.diagnostic_only, acceptance: data.acceptance, status: data.status, wall_ms: data.wall_ms, wall_limit_ms: data.wall_limit_ms, cleanup_reserve_ms: data.cleanup_reserve_ms,
      source_hashes: workflowTimingOriginalHashes(before), source_hashes_after: workflowTimingOriginalHashes(after), source_drift: data.source_drift === null ? null : sourceHashesChanged(workflowTimingOriginalHashes(before), workflowTimingOriginalHashes(after)), progress: data.progress, receipt: data.receipt, wait_receipt: data.wait_receipt, costs: data.costs, json: data.json, native_exit: data.native_exit, stdio_close: data.stdio_close, last_progress_received_ms: data.last_progress_received_ms, cleanup: data.cleanup, limitations: [...attributionLimitations] };
    const original = sanitizeSuiteAttributionDiagnostic(originalInput, sourceLimits, privateEvidence ? { progress: privateEvidence.progress as SuiteProgressSnapshot | null, costs: privateEvidence.costs as SuiteAttributionCosts | null } : undefined); if (!original) return null;
    if ((cases === null) !== (original.progress === null) || cases && original.progress && (cases.sequence !== original.progress.sequence || cases.reporter_elapsed_ms !== original.progress.reporter_elapsed_ms || original.progress.availability === "unavailable" && cases.availability !== "unavailable")) return null;
    const continuity = data.continuity_receipt === null ? null : sanitizePlannerContinuityReceipt(data.continuity_receipt); if (data.continuity_receipt !== null && !continuity) return null;
    const report: SuiteWorkflowTimingDiagnosticReport = { ...original, workload: "full-suite-workflow-timing", source_hashes: before, source_hashes_after: after, source_drift: data.source_drift as boolean | null, workflow_cases: cases, continuity_receipt: continuity, limitations: [...workflowTimingLimitations] };
    if (report.status === "completed" && (Object.keys(before).length !== 20 || report.source_drift !== false || !plannerContinuityPassed(continuity) || cases?.availability !== "available" || !cases.module || cases.window?.start_ms === null || cases.window?.end_ms == null || !cases.coverage || cases.counts?.collected === null || cases.counts?.open !== 0 || cases.counts?.unobserved !== 0)) return null;
    return suiteBoundedJson(report) && Buffer.byteLength(JSON.stringify({ role: "suite-workflow-timing-report", report })) <= SUITE_PROGRESS_LIMITS.snapshot_bytes ? report : null;
  } catch { return null; }
}

async function runLoadedSuiteWorkflowTiming(deadline: ProfileDeadline, metadata: (source: SuiteWorkflowTimingSourceMetadata) => void, delta: (message: unknown) => void, failureHandle?: unknown): Promise<SuiteWorkflowTimingDiagnosticReport> {
  const report = workflowTimingUnavailable(deadline); let receiptRevoked = false;
  const failures = claimP15Controller(failureHandle);
  try {
    report.source_hashes = sourceHashes(SUITE_WORKFLOW_TIMING_SOURCES);
    const fixture = preparePlannerFailureSourceMetadata(); if (!fixture) return p15ControllerReturn(failures, report);
    const source = sanitizeSuiteWorkflowTimingSourceMetadata({ role: "suite-workflow-timing-source", fixture_sha256: fixture.fixture_sha256, sourceLimits: fixture.sourceLimits, source_hashes: report.source_hashes });
    if (!source) return p15ControllerReturn(failures, report); metadata(source);
    const before = prefixInventory("surtec-workflow-worker-"); if (!deadline.mayLaunch()) { report.status = "deadline"; return p15ControllerReturn(failures, report); }
    const costs = createSuiteAttributionCosts(), workflow = createWorkflowCaseTimingProjection();
    const collector = createSuiteProgressCollector(undefined, (frame) => { costs.accept(frame); workflow.accept(frame); const received_ms = deadline.elapsed(); if (!spanTime(received_ms)) return; report.last_progress_received_ms = received_ms; delta({ role: "suite-workflow-timing-frame", frame, received_ms });
      if (failures?.partial) try { p16ControllerFrame(failures.partial, frame); } catch { failures.partial.invalid = true; }
    });
    const revoke = () => { if (!receiptRevoked) { receiptRevoked = true; report.receipt = null; report.wait_receipt = null; report.continuity_receipt = null; delta({ role: "suite-workflow-timing-receipts-unavailable" }); } };
    let output = "", invalid = false; const decoder = new TextDecoder("utf-8", { fatal: true });
    const receipts = createWorkflowTimingOutputCollector({
      span: (receipt) => { report.receipt = receipt; delta({ role: "suite-workflow-timing-receipt", receipt, received_ms: deadline.elapsed() }); },
      wait: (receipt) => { report.wait_receipt = receipt; delta({ role: "suite-workflow-timing-wait", receipt, received_ms: deadline.elapsed() }); },
      continuity: (receipt) => { report.continuity_receipt = receipt; delta({ role: "suite-workflow-timing-continuity", receipt, received_ms: deadline.elapsed() }); },
      revoke,
      data: (chunk) => { try { output += decoder.decode(chunk, { stream: true }); } catch { invalid = true; } },
    }, source.sourceLimits);
    const child = spawn(process.execPath, suiteWorkflowTimingArguments(), { cwd: repository, env: suiteWorkflowTimingEnvironment(process.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.once("exit", (code, signal) => { const observation = suiteExit({ code, signal: signal === null ? null : signal === "SIGTERM" || signal === "SIGKILL" ? signal : "other", received_ms: deadline.elapsed() }); if (observation) { report.native_exit = observation; try { delta({ role: "suite-workflow-timing-exit", native_exit: observation }); } catch { /* Missing delivery remains unknown. */ } } });
    const pending = superviseChild(child, deadline);
    child.stdout?.on("data", (chunk: Buffer) => receipts.push(chunk)); child.stderr?.on("data", (chunk: Buffer) => { collector.push(chunk); if (failures?.partial) try { failures.partial.collector.push(chunk); } catch { failures.partial.sampleInvalid = true; } });
    const outcome = await pending; report.stdio_close = outcome;
    const full = collector.finish(); if (full?.availability === "unavailable") { costs.revoke(); workflow.revoke(); }
    report.progress = compactSuiteProgress(full); report.costs = costs.snapshot(); report.workflow_cases = workflow.snapshot();
    const captured = receipts.finish(); report.receipt = captured.receipt; report.wait_receipt = captured.wait_receipt; report.continuity_receipt = captured.continuity_receipt;
    try { output += decoder.decode(); } catch { invalid = true; }
    if (!invalid && receipts.valid() && outcome.closed && full) report.json = summarizeSuiteProgressJson(output, full, collector.reconcile);
    report.status = outcome.expired ? "deadline" : "failed";
    const normal = outcome.closed && !outcome.expired && !outcome.failed && outcome.exit_code === 0 && report.native_exit?.code === 0 && report.native_exit.signal === null && !invalid && receipts.valid();
    if (normal && report.json?.passed && report.json.first_planner?.passed && [...prefixInventory("surtec-workflow-worker-")].every((name) => before.has(name))) report.cleanup = "verified-normal-suite-and-no-new-planner-prefix-roots";
    if (deadline.remaining() > 0) { report.source_hashes_after = sourceHashes(SUITE_WORKFLOW_TIMING_SOURCES); report.source_drift = sourceHashesChanged(report.source_hashes, report.source_hashes_after); }
    report.wall_ms = deadline.elapsed();
    const evidence = { progress: full, costs: report.costs, workflow_cases: report.workflow_cases }, completed = sanitizeSuiteWorkflowTimingDiagnostic({ ...report, status: "completed" }, source.sourceLimits, evidence);
    if (completed) report.status = "completed";
    const safe = sanitizeSuiteWorkflowTimingDiagnostic(report, source.sourceLimits, evidence); if (!safe) throw new Error();
    if (failures?.partial) try { p16ControllerSeal(failures.partial, safe); } catch { failures.partial.receipt = p16Unavailable("invalid-state", "controller-close"); }
    return p15ControllerReturn(failures, safe, output, full);
  } catch { report.status = deadline.remaining() <= 0 ? "deadline" : "failed"; }
  report.wall_ms = deadline.elapsed(); if (deadline.remaining() <= 0) { report.status = "deadline"; report.cleanup = "unavailable-no-uncertain-fixture-deleted"; } return p15ControllerReturn(failures, report);
}
// P13 observes only the existing parent boundary; it is not another IPC contract.
export const P12_OBSERVATION_REJECTION_SITES = Object.freeze([
  "budget-before-launch", "message-envelope", "message-after-final", "message-count", "source-duplicate", "source-invalid", "source-required",
  "delta-envelope-or-time", "frame-invalid", "progress-replay", "costs-replay", "workflow-replay", "receipt-after-revocation",
  "p09-duplicate", "p09-invalid", "p11-duplicate", "p11-invalid", "p12-duplicate", "p12-invalid", "receipt-revocation-envelope-or-duplicate",
  "exit-envelope-or-duplicate", "exit-invalid-or-time", "final-envelope", "final-sanitizer", "final-binding", "message-role", "ipc-byte-limit",
  "message-handler-exception", "controller-send-exception", "watchdog-exception",
] as const);
export const P12_OBSERVATION_TERMINAL_BRANCHES = Object.freeze([
  "budget-before-launch", "revoked", "controller-not-closed", "controller-expired", "controller-supervision-failed", "controller-exit-nonzero",
  "final-missing", "return-budget", "watchdog-exception", "report-returned",
] as const);
const observationLossRoles = ["source", "frame", "p09", "p11", "p12", "receipts-unavailable", "exit", "final", "other"] as const;
type ObservationLossSite = typeof P12_OBSERVATION_REJECTION_SITES[number];
type ObservationLossBranch = typeof P12_OBSERVATION_TERMINAL_BRANCHES[number];
type ObservationLossRole = typeof observationLossRoles[number] | null;
interface ObservationLossRejection {
  site: ObservationLossSite; role: ObservationLossRole; counted_messages: number; accounted_ipc_bytes: number;
  validated_frame_sequence: number; frame_sequence: number | null; source_seen: boolean; source_valid: boolean;
  final_seen: boolean; final_valid: boolean; receipt_set_revoked: boolean;
}
interface ObservationLossTerminal {
  branch: ObservationLossBranch; original_status: "completed" | "failed" | "deadline";
  controller_supervision: { exit_code: number | null; closed: boolean; expired: boolean; failed: boolean } | null;
}
export interface P12ObservationLossReceipt {
  schema_version: 1; kind: "p12-observation-loss"; observation_point: "watchdog-return"; diagnostic_only: true; acceptance: false; sealed: true;
  capture_status: "captured" | "unavailable"; unavailable_reason: "invalid-binding" | "incomplete-observation" | "invalid-state" | null;
  first_rejection: ObservationLossRejection | null; terminal: ObservationLossTerminal | null;
}
function observationLossUnavailable(reason: NonNullable<P12ObservationLossReceipt["unavailable_reason"]>): P12ObservationLossReceipt {
  return { schema_version: 1, kind: "p12-observation-loss", observation_point: "watchdog-return", diagnostic_only: true, acceptance: false, sealed: true, capture_status: "unavailable", unavailable_reason: reason, first_rejection: null, terminal: null };
}
/** Closed, detached data only; accessors and Proxies are refused without evaluation. */
export function sanitizeP12ObservationLossReceipt(value: unknown): P12ObservationLossReceipt | null {
  try {
    const data = suiteExact(value, ["schema_version", "kind", "observation_point", "diagnostic_only", "acceptance", "sealed", "capture_status", "unavailable_reason", "first_rejection", "terminal"]);
    if (!data || data.schema_version !== 1 || data.kind !== "p12-observation-loss" || data.observation_point !== "watchdog-return" || data.diagnostic_only !== true || data.acceptance !== false || data.sealed !== true) return null;
    if (data.capture_status === "unavailable") return ["invalid-binding", "incomplete-observation", "invalid-state"].includes(data.unavailable_reason as string) && data.first_rejection === null && data.terminal === null ? observationLossUnavailable(data.unavailable_reason as NonNullable<P12ObservationLossReceipt["unavailable_reason"]>) : null;
    if (data.capture_status !== "captured" || data.unavailable_reason !== null) return null;
    let first: ObservationLossRejection | null = null;
    if (data.first_rejection !== null) {
      const row = suiteExact(data.first_rejection, ["site", "role", "counted_messages", "accounted_ipc_bytes", "validated_frame_sequence", "frame_sequence", "source_seen", "source_valid", "final_seen", "final_valid", "receipt_set_revoked"]);
      if (!row || !(P12_OBSERVATION_REJECTION_SITES as readonly unknown[]).includes(row.site) || row.role !== null && !(observationLossRoles as readonly unknown[]).includes(row.role)
        || !suiteInteger(row.counted_messages, 50009) || !suiteInteger(row.accounted_ipc_bytes, 8388608 + 2 * 131072 + 50000 * 128 + 131072)
        || !suiteInteger(row.validated_frame_sequence, 50000) || row.frame_sequence !== null && !suiteInteger(row.frame_sequence, 50000)
        || !["source_seen", "source_valid", "final_seen", "final_valid", "receipt_set_revoked"].every((key) => typeof row[key] === "boolean")) return null;
      first = { site: row.site as ObservationLossSite, role: row.role as ObservationLossRole, counted_messages: row.counted_messages, accounted_ipc_bytes: row.accounted_ipc_bytes, validated_frame_sequence: row.validated_frame_sequence, frame_sequence: row.frame_sequence as number | null, source_seen: row.source_seen as boolean, source_valid: row.source_valid as boolean, final_seen: row.final_seen as boolean, final_valid: row.final_valid as boolean, receipt_set_revoked: row.receipt_set_revoked as boolean };
    }
    const terminal = suiteExact(data.terminal, ["branch", "original_status", "controller_supervision"]);
    if (!terminal || !(P12_OBSERVATION_TERMINAL_BRANCHES as readonly unknown[]).includes(terminal.branch) || !["completed", "failed", "deadline"].includes(terminal.original_status as string)) return null;
    let supervision: ObservationLossTerminal["controller_supervision"] = null;
    if (terminal.controller_supervision !== null) {
      const row = suiteExact(terminal.controller_supervision, ["exit_code", "closed", "expired", "failed"]);
      if (!row || row.exit_code !== null && !Number.isSafeInteger(row.exit_code) || !["closed", "expired", "failed"].every((key) => typeof row[key] === "boolean")) return null;
      supervision = { exit_code: row.exit_code as number | null, closed: row.closed as boolean, expired: row.expired as boolean, failed: row.failed as boolean };
    }
    return { schema_version: 1, kind: "p12-observation-loss", observation_point: "watchdog-return", diagnostic_only: true, acceptance: false, sealed: true, capture_status: "captured", unavailable_reason: null, first_rejection: first, terminal: { branch: terminal.branch as ObservationLossBranch, original_status: terminal.original_status as ObservationLossTerminal["original_status"], controller_supervision: supervision } };
  } catch { return null; }
}
// P14 is parallel diagnostic data; historical P12/P13 contracts stay closed.
export const P14_DELTA_CONDITIONS = Object.freeze(["envelope-shape", "received-ms-range", "delivery-regression", "after-parent-elapsed"] as const);
type P14DeltaCondition = typeof P14_DELTA_CONDITIONS[number];
interface P14DeltaObservation {
  condition: P14DeltaCondition; role: "frame" | "p09" | "p11" | "p12"; counted_messages: number;
  received_ms: number | null; previous_delivery_ms: number | null; parent_elapsed_ms: number | null;
}
export interface P14DeltaRejectionReceipt {
  schema_version: 1; kind: "p14-delta-rejection"; observation_point: "watchdog-return"; diagnostic_only: true; acceptance: false; sealed: true;
  capture_status: "captured" | "unavailable"; unavailable_reason: "invalid-binding" | "incomplete-observation" | "invalid-state" | "not-target-rejection" | null;
  delta: P14DeltaObservation | null;
}
function deltaRejectionUnavailable(reason: NonNullable<P14DeltaRejectionReceipt["unavailable_reason"]>): P14DeltaRejectionReceipt {
  return { schema_version: 1, kind: "p14-delta-rejection", observation_point: "watchdog-return", diagnostic_only: true, acceptance: false, sealed: true, capture_status: "unavailable", unavailable_reason: reason, delta: null };
}
/** Validate only the closed side DTO, never replay the original delta guard. */
export function sanitizeP14DeltaRejectionReceipt(value: unknown): P14DeltaRejectionReceipt | null {
  try {
    const data = suiteExact(value, ["schema_version", "kind", "observation_point", "diagnostic_only", "acceptance", "sealed", "capture_status", "unavailable_reason", "delta"]);
    if (!data || data.schema_version !== 1 || data.kind !== "p14-delta-rejection" || data.observation_point !== "watchdog-return" || data.diagnostic_only !== true || data.acceptance !== false || data.sealed !== true) return null;
    if (data.capture_status === "unavailable") return ["invalid-binding", "incomplete-observation", "invalid-state", "not-target-rejection"].includes(data.unavailable_reason as string) && data.delta === null ? deltaRejectionUnavailable(data.unavailable_reason as NonNullable<P14DeltaRejectionReceipt["unavailable_reason"]>) : null;
    if (data.capture_status !== "captured" || data.unavailable_reason !== null) return null;
    const delta = suiteExact(data.delta, ["condition", "role", "counted_messages", "received_ms", "previous_delivery_ms", "parent_elapsed_ms"]);
    if (!delta || !(P14_DELTA_CONDITIONS as readonly unknown[]).includes(delta.condition) || !["frame", "p09", "p11", "p12"].includes(delta.role as string) || !suiteInteger(delta.counted_messages, 50009)) return null;
    const bounded = (offset: unknown): offset is number => typeof offset === "number" && Number.isFinite(offset) && offset >= 0 && offset <= 900000;
    const measured = delta.condition === "delivery-regression" || delta.condition === "after-parent-elapsed";
    if (measured ? !bounded(delta.received_ms) || !bounded(delta.previous_delivery_ms) : delta.received_ms !== null || delta.previous_delivery_ms !== null) return null;
    if (delta.condition === "after-parent-elapsed" ? !bounded(delta.parent_elapsed_ms) : delta.parent_elapsed_ms !== null) return null;
    return { schema_version: 1, kind: "p14-delta-rejection", observation_point: "watchdog-return", diagnostic_only: true, acceptance: false, sealed: true, capture_status: "captured", unavailable_reason: null,
      delta: { condition: delta.condition as P14DeltaCondition, role: delta.role as P14DeltaObservation["role"], counted_messages: delta.counted_messages, received_ms: delta.received_ms as number | null, previous_delivery_ms: delta.previous_delivery_ms as number | null, parent_elapsed_ms: delta.parent_elapsed_ms as number | null } };
  } catch { return null; }
}
// P15 observes final JSON separately; no historical report or IPC shape changes.
export const P15_FAILURE_LINE_BYTES = 4096;
export const P15_FAILURE_CANDIDATE_MARKER = "P15_SUITE_FAILURES_CANDIDATE ", P15_FAILURE_MARKER = "P15_SUITE_FAILURES_PROFILE ";
export const P15_FAILURE_REASONS = Object.freeze(["incomplete-observation", "invalid-binding", "not-target-report", "missing-candidate", "invalid-transport", "invalid-json", "invalid-state"] as const);
type P15Reason = typeof P15_FAILURE_REASONS[number];
type P15Point = "controller-final-json" | "watchdog-return";
const p15Names = ["Error", "AssertionError", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "AggregateError", "unknown"] as const;
type P15Name = typeof p15Names[number];
type P15Signature = "test-timeout-5000" | "hook-timeout-10000" | "assertion-failure" | "typed-error" | "unsupported";
interface P15Site { line: number; column: number }
interface P15Error { index: number; reported_name: P15Name; signature: P15Signature; message: string | null; sites: P15Site[]; positions_status: "reported-not-source-verified" | "unavailable" | "limit-reached" }
interface P15Errors { capture_status: "captured" | "unavailable"; unavailable_reason: "missing-errors" | "invalid-errors" | null; reported_count: number | null; retained_count: number; omitted_count: number | null; classification_complete: boolean; entries: P15Error[] }
interface P15Identity { module: { ordinal: number; source: string }; case_ordinal: number }
interface P15Case extends P15Identity { full_name_sha256: string | null; declaration: P15Site | null; declaration_status: "reported-not-source-verified" | "unavailable"; errors: P15Errors }
interface P15Binding { source_fingerprint: string; progress_sequence: number; module_count: number; passed_tests: number; failed_tests: number; skipped_tests: number }
export interface P15SuiteFailuresReceipt {
  schema_version: 1; kind: "p15-suite-failures"; observation_point: P15Point; diagnostic_only: true; acceptance: false; sealed: true;
  capture_status: "captured" | "unavailable"; unavailable_reason: P15Reason | null; binding: P15Binding | null;
  failed_total: number | null; retained_cases: number; omitted_cases: number | null; classification_complete: boolean; cases: P15Case[];
}
function p15Unavailable(reason: P15Reason, point: P15Point = "watchdog-return"): P15SuiteFailuresReceipt {
  return { schema_version: 1, kind: "p15-suite-failures", observation_point: point, diagnostic_only: true, acceptance: false, sealed: true, capture_status: "unavailable", unavailable_reason: reason, binding: null, failed_total: null, retained_cases: 0, omitted_cases: null, classification_complete: false, cases: [] };
}
/** Dense own data only; construction and unavailable reads do not touch codecs. */
function p15Array(value: unknown, maximum: number): unknown[] | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || !Array.isArray(value)) return null;
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!suiteInteger(length, maximum) || Reflect.ownKeys(value).length !== length + 1) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) { const d = Object.getOwnPropertyDescriptor(value, String(index)); if (!d || !Object.hasOwn(d, "value") || !d.enumerable) return null; result.push(d.value); }
  return result;
}
function p15Source(value: unknown): value is string {
  return typeof value === "string" && value.length <= 192 && /^[\x21-\x7e]+$/.test(value) && /^(cli|dashboard|lib|runner|scripts)\/(?:[^/]+\/)*[^/]+\.test\.tsx?$/.test(value) && !/["\\?#:%]/.test(value) && value.split("/").every((part) => part !== "." && part !== ".." && part.length > 0);
}
function p15Site(value: unknown): P15Site | null { const d = suiteExact(value, ["line", "column"]); return d && suiteInteger(d.line, 10000, 1) && suiteInteger(d.column, 65536, 1) ? { line: d.line, column: d.column } : null; }
function p15Canonical(name: P15Name, signature: P15Signature): string | null | undefined {
  if (signature === "test-timeout-5000") return "Test timed out in 5000ms.";
  if (signature === "hook-timeout-10000") return "Hook timed out in 10000ms.";
  if (signature === "assertion-failure") return name === "AssertionError" ? "Assertion failed (values omitted)." : undefined;
  if (signature === "typed-error") {
    const messages: Partial<Record<P15Name, string>> = { TypeError: "Type error (details omitted).", RangeError: "Range error (details omitted).", ReferenceError: "Reference error (details omitted).", SyntaxError: "Syntax error (details omitted).", AggregateError: "Aggregate error (details omitted)." };
    return Object.hasOwn(messages, name) ? messages[name] : undefined;
  }
  return signature === "unsupported" && (name === "Error" || name === "unknown") ? null : undefined;
}
function p15ErrorsUnavailable(reason: "missing-errors" | "invalid-errors"): P15Errors { return { capture_status: "unavailable", unavailable_reason: reason, reported_count: null, retained_count: 0, omitted_count: null, classification_complete: false, entries: [] }; }
function p15SanitizeErrors(value: unknown): P15Errors | null {
  const d = suiteExact(value, ["capture_status", "unavailable_reason", "reported_count", "retained_count", "omitted_count", "classification_complete", "entries"]); if (!d) return null;
  const input = p15Array(d.entries, 2); if (!input) return null;
  if (d.capture_status === "unavailable") return ["missing-errors", "invalid-errors"].includes(d.unavailable_reason as string) && d.reported_count === null && d.retained_count === 0 && d.omitted_count === null && d.classification_complete === false && input.length === 0 ? p15ErrorsUnavailable(d.unavailable_reason as "missing-errors" | "invalid-errors") : null;
  if (d.capture_status !== "captured" || d.unavailable_reason !== null || !suiteInteger(d.reported_count, 20000, 1) || d.retained_count !== Math.min(2, d.reported_count) || input.length !== d.retained_count || d.omitted_count !== d.reported_count - input.length) return null;
  const entries: P15Error[] = [];
  for (const value of input) {
    const e = suiteExact(value, ["index", "reported_name", "signature", "message", "sites", "positions_status"]); if (!e || e.index !== entries.length || !(p15Names as readonly unknown[]).includes(e.reported_name)) return null;
    const name = e.reported_name as P15Name, signature = e.signature as P15Signature, message = p15Canonical(name, signature), sites = p15Array(e.sites, 2);
    if (message === undefined || e.message !== message || !sites || !["reported-not-source-verified", "unavailable", "limit-reached"].includes(e.positions_status as string)) return null;
    const safeSites: P15Site[] = []; for (const site of sites) { const safe = p15Site(site); if (!safe) return null; safeSites.push(safe); }
    if (e.positions_status === "unavailable" && safeSites.length !== 0 || e.positions_status === "reported-not-source-verified" && safeSites.length === 0) return null;
    entries.push({ index: entries.length, reported_name: name, signature, message, sites: safeSites, positions_status: e.positions_status as P15Error["positions_status"] });
  }
  const complete = d.omitted_count === 0 && entries.every((entry) => entry.signature !== "unsupported"); if (d.classification_complete !== complete) return null;
  return { capture_status: "captured", unavailable_reason: null, reported_count: d.reported_count, retained_count: entries.length, omitted_count: d.reported_count - entries.length, classification_complete: complete, entries };
}
function p15Compare(a: P15Identity, b: P15Identity): number { return a.module.ordinal - b.module.ordinal || a.case_ordinal - b.case_ordinal; }
/** Point-specific, closed DTO; no original validator or admission guard is replayed. */
export function sanitizeP15SuiteFailuresReceipt(value: unknown, point: P15Point = "watchdog-return"): P15SuiteFailuresReceipt | null {
  try {
    if (point !== "watchdog-return" && point !== "controller-final-json") return null;
    const d = suiteExact(value, ["schema_version", "kind", "observation_point", "diagnostic_only", "acceptance", "sealed", "capture_status", "unavailable_reason", "binding", "failed_total", "retained_cases", "omitted_cases", "classification_complete", "cases"]);
    if (!d || d.schema_version !== 1 || d.kind !== "p15-suite-failures" || d.observation_point !== point || d.diagnostic_only !== true || d.acceptance !== false || d.sealed !== true) return null;
    const input = p15Array(d.cases, 2); if (!input) return null;
    if (d.capture_status === "unavailable") return (point === "controller-final-json" ? ["invalid-json", "invalid-state"] : P15_FAILURE_REASONS as readonly unknown[]).includes(d.unavailable_reason) && d.binding === null && d.failed_total === null && d.retained_cases === 0 && d.omitted_cases === null && d.classification_complete === false && input.length === 0 ? p15Unavailable(d.unavailable_reason as P15Reason, point) : null;
    const b = suiteExact(d.binding, ["source_fingerprint", "progress_sequence", "module_count", "passed_tests", "failed_tests", "skipped_tests"]);
    if (d.capture_status !== "captured" || d.unavailable_reason !== null || !b || typeof b.source_fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(b.source_fingerprint) || !suiteInteger(b.progress_sequence, 50000, 1) || !suiteInteger(b.module_count, 256, 1) || !suiteInteger(b.passed_tests, 20000) || !suiteInteger(b.failed_tests, 20000, 1) || !suiteInteger(b.skipped_tests, 20000) || b.passed_tests + b.failed_tests + b.skipped_tests > 20000 || d.failed_total !== b.failed_tests || d.retained_cases !== Math.min(2, b.failed_tests) || input.length !== d.retained_cases || d.omitted_cases !== b.failed_tests - input.length) return null;
    const cases: P15Case[] = [];
    for (const value of input) {
      const c = suiteExact(value, ["module", "case_ordinal", "full_name_sha256", "declaration", "declaration_status", "errors"]), m = c && suiteExact(c.module, ["ordinal", "source"]); if (!c || !m || !suiteInteger(m.ordinal, b.module_count, 1) || !p15Source(m.source) || !suiteInteger(c.case_ordinal, 20000, 1) || c.full_name_sha256 !== null && (typeof c.full_name_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(c.full_name_sha256))) return null;
      const declaration = c.declaration === null ? null : p15Site(c.declaration), errors = p15SanitizeErrors(c.errors);
      if (c.declaration === null ? c.declaration_status !== "unavailable" : !declaration || c.declaration_status !== "reported-not-source-verified") return null;
      if (!errors) return null;
      const next: P15Case = { module: { ordinal: m.ordinal, source: m.source }, case_ordinal: c.case_ordinal, full_name_sha256: c.full_name_sha256 as string | null, declaration, declaration_status: c.declaration_status as P15Case["declaration_status"], errors };
      const previous = cases.at(-1); if (previous && (p15Compare(previous, next) >= 0 || previous.module.ordinal === next.module.ordinal && previous.module.source !== next.module.source)) return null;
      cases.push(next);
    }
    const complete = d.omitted_cases === 0 && cases.every((c) => c.errors.capture_status === "captured" && c.errors.classification_complete); if (d.classification_complete !== complete) return null;
    return { schema_version: 1, kind: "p15-suite-failures", observation_point: point, diagnostic_only: true, acceptance: false, sealed: true, capture_status: "captured", unavailable_reason: null,
      binding: { source_fingerprint: b.source_fingerprint, progress_sequence: b.progress_sequence, module_count: b.module_count, passed_tests: b.passed_tests, failed_tests: b.failed_tests, skipped_tests: b.skipped_tests }, failed_total: b.failed_tests, retained_cases: cases.length, omitted_cases: b.failed_tests - cases.length, classification_complete: complete, cases };
  } catch { return null; }
}
function p15Fingerprint(value: unknown): string | null {
  const hashes = suiteRecord(value, 20); if (!hashes || Object.keys(hashes).length !== 20) return null;
  const pairs: Array<[string, string]> = []; for (const source of SUITE_WORKFLOW_TIMING_SOURCES) { const hash = hashes[source]; if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return null; pairs.push([source, hash]); }
  return createHash("sha256").update(JSON.stringify(pairs)).digest("hex");
}
function p15String(value: unknown, maximum: number): value is string { return typeof value === "string" && value.length <= maximum && Buffer.byteLength(value) <= maximum; }
function p15ProjectErrors(value: unknown, source: string): P15Errors {
  if (value === undefined || value === null) return p15ErrorsUnavailable("missing-errors");
  const messages = p15Array(value, 20000); if (!messages) return p15ErrorsUnavailable("invalid-errors"); if (!messages.length) return p15ErrorsUnavailable("missing-errors");
  if (!messages.every((message) => p15String(message, 65536))) return p15ErrorsUnavailable("invalid-errors");
  const absolute = join(repository, source).replace(/\\/g, "/"), url = new URL("file:///" + absolute.replace(/^\/+/, "").split("/").map((part, index) => index === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)).join("/")).href;
  const paths = [absolute, url].map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), pattern = new RegExp(`(?:^|[ (])(?:${paths.join("|")}):(\\d{1,5}):(\\d{1,5})(?:\\)|\\s*)$`);
  const entries: P15Error[] = [];
  for (let index = 0; index < Math.min(2, messages.length); index++) {
    const raw = messages[index] as string, header = /^(Error|AssertionError|TypeError|RangeError|ReferenceError|SyntaxError|AggregateError): /.exec(raw), name = (header?.[1] ?? "unknown") as P15Name, text = header ? raw.slice(header[0].length) : raw;
    const timeout = (message: string) => text === message || text.startsWith(message + "\n") && text.slice(message.length + 1).split(/\r?\n/).filter((line) => line.length > 0).every((line) => /^\s+at /.test(line));
    const signature: P15Signature = timeout(PLANNER_TEST_TIMEOUT_MESSAGE) ? "test-timeout-5000" : timeout(PLANNER_HOOK_TIMEOUT_MESSAGE) ? "hook-timeout-10000" : name === "AssertionError" ? "assertion-failure" : p15Canonical(name, "typed-error") !== undefined ? "typed-error" : "unsupported";
    const lines = raw.split(/\r?\n/, 129), sites: P15Site[] = []; let limited = lines.length > 128;
    for (const line of lines.slice(0, 128)) { const match = pattern.exec(line.replace(/\\/g, "/")); if (!match) continue; const site = p15Site({ line: Number(match[1]), column: Number(match[2]) }); if (!site) continue; if (sites.length === 2) { limited = true; continue; } sites.push(site); }
    entries.push({ index, reported_name: name, signature, message: p15Canonical(name, signature) ?? null, sites, positions_status: limited ? "limit-reached" : sites.length ? "reported-not-source-verified" : "unavailable" });
  }
  return { capture_status: "captured", unavailable_reason: null, reported_count: messages.length, retained_count: entries.length, omitted_count: messages.length - entries.length, classification_complete: messages.length === entries.length && entries.every((entry) => entry.signature !== "unsupported"), entries };
}
/** Pure side projection. Its inputs must already have passed original reconciliation. */
export function projectP15SuiteFailures(output: string, progress: SuiteProgressSnapshot, summary: SuiteProgressJsonSummary, hashes: Record<string, string>): P15SuiteFailuresReceipt {
  const unavailable = () => p15Unavailable("invalid-json", "controller-final-json");
  try {
    if (!p15String(output, OUTPUT_LIMIT)) return unavailable();
    const p = plainAggregate(progress), s = suiteExact(summary, ["passed", "module_count", "passed_tests", "failed_tests", "skipped_tests", "first_planner"]), modules = p && p15Array(p.modules, 256), counts = p && plainAggregate(p.counts), fingerprint = p15Fingerprint(hashes);
    if (!p || p.availability !== "available" || !s || s.passed !== false || !modules || !counts || !fingerprint || !suiteInteger(p.sequence, 50000, 1) || !suiteInteger(s.module_count, 256, 1) || modules.length !== s.module_count || p.module_count !== s.module_count || !suiteInteger(s.failed_tests, 20000, 1) || !suiteInteger(s.passed_tests, 20000) || !suiteInteger(s.skipped_tests, 20000) || counts.failed !== s.failed_tests || counts.passed !== s.passed_tests || counts.skipped !== s.skipped_tests || s.passed_tests + s.failed_tests + s.skipped_tests > 20000) return unavailable();
    const start = output.search(/\{\s*"numTotalTestSuites"\s*:/); if (start < 0) return unavailable();
    const data = plainAggregate(suiteParseJson(output.slice(start))), results = data && p15Array(data.testResults, 256); if (!data || data.success !== false || !results || results.length !== modules.length) return unavailable();
    const bySource = new Map<string, Record<string, unknown>>(), ordinals = new Set<number>();
    for (const value of modules) { const m = plainAggregate(value); if (!m || !p15Source(m.source) || !suiteInteger(m.ordinal, s.module_count, 1) || bySource.has(m.source) || ordinals.has(m.ordinal)) return unavailable(); bySource.set(m.source, m); ordinals.add(m.ordinal); }
    let passed = 0, failed = 0, skipped = 0, total = 0; const seen = new Set<string>(), selected: Array<{ identity: P15Identity; raw: Record<string, unknown> }> = [];
    for (const value of results) {
      const m = plainAggregate(value), path = m && suiteRelative(m.name), binding = path && bySource.get(path), assertions = m && p15Array(m.assertionResults, 20000), expected = binding && plainAggregate(binding.counts);
      if (!m || !path || !binding || !assertions || !expected || seen.has(path) || assertions.length !== expected.collected || !["passed", "failed"].includes(m.status as string) || binding.ended && (binding.state === "failed") !== (m.status === "failed")) return unavailable(); seen.add(path);
      let mp = 0, mf = 0, ms = 0;
      for (let index = 0; index < assertions.length; index++) {
        if (++total > 20000) return unavailable(); const test = plainAggregate(assertions[index]); if (!test) return unavailable();
        if (test.status === "passed") { passed++; mp++; } else if (["pending", "todo", "skipped"].includes(test.status as string)) { skipped++; ms++; }
        else if (test.status === "failed") { failed++; mf++; selected.push({ identity: { module: { ordinal: binding.ordinal as number, source: path }, case_ordinal: index + 1 }, raw: test }); selected.sort((a, b) => p15Compare(a.identity, b.identity)); if (selected.length > 2) selected.pop(); }
        else return unavailable();
      }
      if (mp !== expected.passed || mf !== expected.failed || ms !== expected.skipped || assertions.length !== expected.finished) return unavailable();
    }
    if (passed !== s.passed_tests || failed !== s.failed_tests || skipped !== s.skipped_tests || counts.finished !== total || counts.collected !== total || Object.hasOwn(data, "numFailedTests") && data.numFailedTests !== failed || Object.hasOwn(data, "numPassedTests") && data.numPassedTests !== passed || Object.hasOwn(data, "numTotalTests") && data.numTotalTests !== total) return unavailable();
    const cases: P15Case[] = selected.map(({ identity, raw }) => { const declaration = p15Site(raw.location); return { ...identity, full_name_sha256: p15String(raw.fullName, 2048) ? createHash("sha256").update(raw.fullName).digest("hex") : null, declaration, declaration_status: declaration ? "reported-not-source-verified" : "unavailable", errors: p15ProjectErrors(raw.failureMessages, identity.module.source) }; });
    return sanitizeP15SuiteFailuresReceipt({ schema_version: 1, kind: "p15-suite-failures", observation_point: "controller-final-json", diagnostic_only: true, acceptance: false, sealed: true, capture_status: "captured", unavailable_reason: null,
      binding: { source_fingerprint: fingerprint, progress_sequence: p.sequence, module_count: s.module_count, passed_tests: passed, failed_tests: failed, skipped_tests: skipped }, failed_total: failed, retained_cases: cases.length, omitted_cases: failed - cases.length, classification_complete: failed === cases.length && cases.every((c) => c.errors.classification_complete), cases }, "controller-final-json") ?? unavailable();
  } catch { return unavailable(); }
}
/** No codec, buffer, timer or filesystem work until issued pipe data arrives. */
export function createP15SuiteFailureCollector() {
  let line: number[] = [], discard = false, bytes = 0, invalid = false, sealed = false, seen = false, candidate: P15SuiteFailuresReceipt | null = null, decoder: TextDecoder | undefined;
  const reserved = () => { const text = String.fromCharCode(...line); return text.startsWith("P15_SUITE_FAILURES_") || line.length > 0 && P15_FAILURE_CANDIDATE_MARKER.startsWith(text); };
  const emit = () => {
    if (reserved()) {
      if (seen || discard) { invalid = true; return; } seen = true;
      try { const text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(line)); if (!text.startsWith(P15_FAILURE_CANDIDATE_MARKER)) { invalid = true; return; } candidate = sanitizeP15SuiteFailuresReceipt(suiteParseJson(text.slice(P15_FAILURE_CANDIDATE_MARKER.length)), "controller-final-json"); if (!candidate) invalid = true; } catch { invalid = true; }
    }
  };
  return Object.freeze({
    push(chunk: unknown): void {
      if (sealed || invalid) return;
      try {
        if (typeof chunk !== "string" && (!chunk || typeof chunk !== "object" || nodeTypes.isProxy(chunk) || !Buffer.isBuffer(chunk))) { invalid = true; return; }
        const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk as Buffer; bytes += data.length; if (bytes > OUTPUT_LIMIT) { invalid = true; return; }
        decoder ??= new TextDecoder("utf-8", { fatal: true }); decoder.decode(data, { stream: true });
        for (const byte of data) { if (byte === 10) { if (!discard || reserved()) emit(); line = []; discard = false; if (invalid) return; } else if (!discard) { if (line.length < P15_FAILURE_LINE_BYTES - 1) line.push(byte); else { if (reserved()) invalid = true; discard = true; if (invalid) return; } } }
      } catch { invalid = true; }
    },
    finish(): { status: "candidate" | "missing" | "invalid"; candidate: P15SuiteFailuresReceipt | null } {
      if (!sealed) { sealed = true; try { decoder?.decode(); } catch { invalid = true; } if (line.length && reserved()) invalid = true; line = []; }
      if (invalid) return { status: "invalid", candidate: null };
      if (!candidate) return { status: "missing", candidate: null };
      const safe = sanitizeP15SuiteFailuresReceipt(candidate, "controller-final-json"); return safe ? { status: "candidate", candidate: safe } : { status: "invalid", candidate: null };
    },
  });
}
interface P15ControllerState { claimed: boolean; sealed: boolean; emitted: boolean; report: SuiteWorkflowTimingDiagnosticReport | null; target: boolean; receipt: P15SuiteFailuresReceipt; partial: P16ControllerState }
const p15ControllerHandles = new WeakMap<object, P15ControllerState>();
function createP15ControllerCapture() {
  const handle = Object.freeze({}), state: P15ControllerState = { claimed: false, sealed: false, emitted: false, report: null, target: false, receipt: p15Unavailable("invalid-state", "controller-final-json"), partial: createP16ControllerState() }; p15ControllerHandles.set(handle, state);
  return Object.freeze({ handle, emit(report: unknown): void {
    if (state.sealed && state.report === report && !state.emitted && state.target) { state.emitted = true;
      try { const safe = sanitizeP15SuiteFailuresReceipt(state.receipt, "controller-final-json"); if (!safe) return; const line = `${P15_FAILURE_CANDIDATE_MARKER}${JSON.stringify(safe)}\n`; if (Buffer.byteLength(line) <= P15_FAILURE_LINE_BYTES) process.stderr.write(line); } catch { /* Original final IPC callback/exit remains authoritative. */ }
    }
    if (!state.sealed || state.report !== report || state.target || state.partial.emitted || state.partial.receipt?.capture_status !== "captured") return; state.partial.emitted = true;
    try { const safe = sanitizeP16PartialSuiteReceipt(state.partial.receipt, "controller-close"); if (!safe) return; const line = `${P16_CANDIDATE_MARKER}${JSON.stringify(safe)}\n`; if (Buffer.byteLength(line) <= 4096) process.stderr.write(line); } catch { /* Best effort after the unchanged original final send. */ }
  } });
}
function claimP15Controller(handle: unknown): P15ControllerState | null { if (!handle || typeof handle !== "object") return null; const state = p15ControllerHandles.get(handle); if (!state || state.claimed) return null; state.claimed = true; return state; }
function p15ControllerReturn(state: P15ControllerState | null, report: SuiteWorkflowTimingDiagnosticReport, output?: string, progress?: SuiteProgressSnapshot | null): SuiteWorkflowTimingDiagnosticReport {
  if (!state || state.sealed) return report; state.sealed = true; state.report = report;
  try { state.target = report.status === "failed" && report.json?.passed === false && report.json.failed_tests > 0; state.receipt = output !== undefined && progress && report.json && report.source_drift === false ? projectP15SuiteFailures(output, progress, report.json, report.source_hashes) : p15Unavailable("invalid-json", "controller-final-json"); }
  catch { state.receipt = p15Unavailable("invalid-state", "controller-final-json"); } return report;
}
interface P15ParentState { invalid: boolean; target: boolean; failed_count: number; selected: P15Identity[]; collector: ReturnType<typeof createP15SuiteFailureCollector>; receipt: P15SuiteFailuresReceipt | null }
function p15ObserveFrame(state: ObservationLossState | null, frame: SuiteProgressFrame): void {
  if (!state || state.sealed || state.failures.invalid) return;
  try { if (frame.event !== "case-result" || frame.data.state !== "failed") return; const next: P15Identity = { module: { ordinal: frame.module!.ordinal, source: frame.module!.source }, case_ordinal: frame.case!.ordinal }; state.failures.failed_count++; state.failures.selected.push(next); state.failures.selected.sort(p15Compare); if (state.failures.selected.length > 2) state.failures.selected.pop(); } catch { state.failures.invalid = true; }
}
function p15TargetReport(report: SuiteWorkflowTimingDiagnosticReport): boolean {
  const json = report.json, progress = report.progress;
  return report.status === "failed" && json?.passed === false && json.failed_tests > 0 && progress?.availability === "available" && progress.open_case_count === 0 && progress.ended_modules === progress.module_count && progress.counts.finished === progress.counts.collected && progress.run_end !== null && report.native_exit !== null && report.stdio_close?.closed === true && !report.stdio_close.expired && !report.stdio_close.failed;
}
function sealP15Failures(state: ObservationLossState, report: SuiteWorkflowTimingDiagnosticReport): P15SuiteFailuresReceipt {
  if (state.receipt?.capture_status !== "captured") return p15Unavailable("invalid-state");
  if (state.receipt.first_rejection !== null || state.receipt.terminal?.branch !== "report-returned" || !p15TargetReport(report)) return p15Unavailable("not-target-report"); state.failures.target = true;
  if (state.failures.invalid) return p15Unavailable("invalid-state");
  const collected = state.failures.collector.finish(); if (collected.status !== "candidate") return p15Unavailable(collected.status === "missing" ? "missing-candidate" : "invalid-transport");
  const candidate = collected.candidate!; if (candidate.capture_status === "unavailable") return p15Unavailable(candidate.unavailable_reason!);
  const fingerprint = report.source_drift === false ? p15Fingerprint(report.source_hashes) : null, after = fingerprint ? p15Fingerprint(report.source_hashes_after) : null, b = candidate.binding!, json = report.json!, progress = report.progress!;
  if (!fingerprint || after !== fingerprint || b.source_fingerprint !== fingerprint || b.progress_sequence !== progress.sequence || b.module_count !== json.module_count || b.passed_tests !== json.passed_tests || b.failed_tests !== json.failed_tests || b.skipped_tests !== json.skipped_tests || state.failures.failed_count !== b.failed_tests || candidate.cases.length !== state.failures.selected.length || candidate.cases.some((c, index) => p15Compare(c, state.failures.selected[index]!) !== 0 || c.module.source !== state.failures.selected[index]!.module.source)) return p15Unavailable("invalid-binding");
  return sanitizeP15SuiteFailuresReceipt({ ...candidate, observation_point: "watchdog-return" }) ?? p15Unavailable("invalid-state");
}
/** Original strings and P13 priority are retained; this never serializes a report. */
export function formatP15SuiteFailuresLine(value: unknown, originalReportLine: string, p13Line: string): string | null {
  try { const safe = sanitizeP15SuiteFailuresReceipt(value); if (!safe || typeof originalReportLine !== "string" || !originalReportLine.endsWith("\n") || typeof p13Line !== "string" || !p13Line.startsWith("P12_OBSERVATION_LOSS_PROFILE ") || !p13Line.endsWith("\n")) return null;
    const line = `${P15_FAILURE_MARKER}${JSON.stringify(safe)}\n`, bytes = Buffer.byteLength(line), prior = Buffer.byteLength(p13Line), wrapper = Buffer.byteLength('{"role":"suite-workflow-timing-report","report":') + 1;
    return bytes <= P15_FAILURE_LINE_BYTES && prior <= 2048 && Buffer.byteLength(originalReportLine) + wrapper + prior + bytes <= 131072 ? line : null;
  } catch { return null; }
}

// P16 is partial evidence, not a replacement for complete JSON or acceptance.
export const P16_SAMPLE_MARKER = "P16_SUITE_SAMPLE ", P16_CANDIDATE_MARKER = "P16_SUITE_EVIDENCE_CANDIDATE ", P16_PARTIAL_MARKER = "P16_PARTIAL_SUITE_PROFILE ";
type P16Reason = "incomplete-observation" | "invalid-binding" | "invalid-state" | "not-target-report";
type P16DetailReason = "missing-sample" | "invalid-sample" | "missing-candidate" | "invalid-transport" | "invalid-binding";
interface P16Binding { source_fingerprint: string; progress_sequence: number; original_status: "failed" | "deadline"; selected_modules: number; observed_modules: number; ended_modules: number; counts: SuiteProgressCounts; run_end_seen: boolean }
interface P16Values { duration: number; environmentSetupDuration: number; prepareDuration: number; collectDuration: number; setupDuration: number }
interface P16Timing { capture_status: "captured" | "unavailable"; unavailable_reason: P16DetailReason | null; measurement: "vitest-reported-inclusive-zero-fallback" | null; module: { ordinal: number; source: string } | null; reporter_end_ms: number | null; state: SuiteProgressState | null; values: P16Values | null }
interface P16Failures { selection: "lowest-two-admitted-tuples"; observed: number; retained: number; omitted: number; classification_complete: boolean; entries: Array<P15Identity & { errors: P15Errors }> }
export interface P16PartialSuiteReceipt { schema_version: 1; kind: "p16-partial-suite-evidence"; observation_point: "watchdog-return" | "controller-close"; diagnostic_only: true; acceptance: false; sealed: true; partial: true; capture_status: "captured" | "unavailable"; unavailable_reason: P16Reason | null; binding: P16Binding | null; failures: P16Failures | null; timing: P16Timing | null }
interface P16Sample { schema_version: 1; kind: "p16-suite-sample"; type: "failure" | "module"; sequence: number; reporter_elapsed_ms: number; module: { ordinal: number; source: string }; case_ordinal: number | null; errors: P15Errors | null; timing: P16Timing | null }
function p16Unavailable(reason: P16Reason, point: P16PartialSuiteReceipt["observation_point"] = "watchdog-return"): P16PartialSuiteReceipt { return { schema_version: 1, kind: "p16-partial-suite-evidence", observation_point: point, diagnostic_only: true, acceptance: false, sealed: true, partial: true, capture_status: "unavailable", unavailable_reason: reason, binding: null, failures: null, timing: null }; }
function p16TimingUnavailable(reason: P16DetailReason): P16Timing { return { capture_status: "unavailable", unavailable_reason: reason, measurement: null, module: null, reporter_end_ms: null, state: null, values: null }; }
function p16Time(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 900000; }
function p16Own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value)) throw new Error();
  const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor) return undefined; if (!Object.hasOwn(descriptor, "value")) throw new Error(); return descriptor.value;
}
function p16Module(value: unknown): P15Identity["module"] | null { const m = suiteExact(value, ["ordinal", "source"]); return m && suiteInteger(m.ordinal, 256, 1) && p15Source(m.source) ? { ordinal: m.ordinal, source: m.source } : null; }
function p16Counts(value: unknown): SuiteProgressCounts | null {
  const keys = ["collected", "ready", "finished", "passed", "failed", "skipped"] as const, c = suiteExact(value, keys);
  if (!c || !keys.every((key) => suiteInteger(c[key], 20000)) || c.finished !== (c.passed as number) + (c.failed as number) + (c.skipped as number) || (c.ready as number) < (c.passed as number) + (c.failed as number) || (c.ready as number) > (c.collected as number) || (c.finished as number) > (c.collected as number)) return null;
  return { collected: c.collected as number, ready: c.ready as number, finished: c.finished as number, passed: c.passed as number, failed: c.failed as number, skipped: c.skipped as number };
}
function p16Binding(value: unknown): P16Binding | null {
  const b = suiteExact(value, ["source_fingerprint", "progress_sequence", "original_status", "selected_modules", "observed_modules", "ended_modules", "counts", "run_end_seen"]), counts = b && p16Counts(b.counts);
  return b && counts && typeof b.source_fingerprint === "string" && /^[a-f0-9]{64}$/.test(b.source_fingerprint) && suiteInteger(b.progress_sequence, 50000, 1) && ["failed", "deadline"].includes(b.original_status as string) && suiteInteger(b.selected_modules, 256, 1) && suiteInteger(b.observed_modules, b.selected_modules, 1) && suiteInteger(b.ended_modules, b.observed_modules) && typeof b.run_end_seen === "boolean" ? { source_fingerprint: b.source_fingerprint, progress_sequence: b.progress_sequence, original_status: b.original_status as P16Binding["original_status"], selected_modules: b.selected_modules, observed_modules: b.observed_modules, ended_modules: b.ended_modules, counts, run_end_seen: b.run_end_seen } : null;
}
function p16Timing(value: unknown): P16Timing | null {
  const t = suiteExact(value, ["capture_status", "unavailable_reason", "measurement", "module", "reporter_end_ms", "state", "values"]); if (!t) return null;
  if (t.capture_status === "unavailable") return ["missing-sample", "invalid-sample", "missing-candidate", "invalid-transport", "invalid-binding"].includes(t.unavailable_reason as string) && t.measurement === null && t.module === null && t.reporter_end_ms === null && t.state === null && t.values === null ? p16TimingUnavailable(t.unavailable_reason as P16DetailReason) : null;
  const module = p16Module(t.module), v = suiteExact(t.values, ["duration", "environmentSetupDuration", "prepareDuration", "collectDuration", "setupDuration"]);
  if (t.capture_status !== "captured" || t.unavailable_reason !== null || t.measurement !== "vitest-reported-inclusive-zero-fallback" || !module || module.source !== "runner/workflow-orchestrator.test.ts" || !p16Time(t.reporter_end_ms) || !["passed", "failed", "skipped"].includes(t.state as string) || !v || !Object.values(v).every(p16Time)) return null;
  return { capture_status: "captured", unavailable_reason: null, measurement: t.measurement, module, reporter_end_ms: t.reporter_end_ms, state: t.state as SuiteProgressState, values: { duration: v.duration as number, environmentSetupDuration: v.environmentSetupDuration as number, prepareDuration: v.prepareDuration as number, collectDuration: v.collectDuration as number, setupDuration: v.setupDuration as number } };
}
/** Closed point-specific DTO: optional errors/timing never erase admitted identity. */
export function sanitizeP16PartialSuiteReceipt(value: unknown, point: P16PartialSuiteReceipt["observation_point"] = "watchdog-return"): P16PartialSuiteReceipt | null {
  try {
    if (point !== "watchdog-return" && point !== "controller-close") return null;
    const d = suiteExact(value, ["schema_version", "kind", "observation_point", "diagnostic_only", "acceptance", "sealed", "partial", "capture_status", "unavailable_reason", "binding", "failures", "timing"]);
    if (!d || d.schema_version !== 1 || d.kind !== "p16-partial-suite-evidence" || d.observation_point !== point || d.diagnostic_only !== true || d.acceptance !== false || d.sealed !== true || d.partial !== true) return null;
    if (d.capture_status === "unavailable") return ["incomplete-observation", "invalid-binding", "invalid-state", "not-target-report"].includes(d.unavailable_reason as string) && d.binding === null && d.failures === null && d.timing === null ? p16Unavailable(d.unavailable_reason as P16Reason, point) : null;
    const binding = p16Binding(d.binding), f = suiteExact(d.failures, ["selection", "observed", "retained", "omitted", "classification_complete", "entries"]), timing = p16Timing(d.timing), rows = f && p15Array(f.entries, 2);
    if (d.capture_status !== "captured" || d.unavailable_reason !== null || !binding || !f || !timing || !rows || f.selection !== "lowest-two-admitted-tuples" || f.observed !== binding.counts.failed || f.retained !== Math.min(2, binding.counts.failed) || rows.length !== f.retained || f.omitted !== binding.counts.failed - rows.length) return null;
    const entries: P16Failures["entries"] = [];
    for (const row of rows) { const e = suiteExact(row, ["module", "case_ordinal", "errors"]), module = e && p16Module(e.module), errors = e && p15SanitizeErrors(e.errors); if (!e || !module || module.ordinal > binding.selected_modules || !suiteInteger(e.case_ordinal, 20000, 1) || !errors) return null;
      const next = { module, case_ordinal: e.case_ordinal, errors }, previous = entries.at(-1); if (previous && (p15Compare(previous, next) >= 0 || (previous.module.ordinal === module.ordinal ? previous.module.source !== module.source : previous.module.source >= module.source))) return null; entries.push(next); }
    const complete = entries.length > 0 && f.omitted === 0 && entries.every((e) => e.errors.capture_status === "captured" && e.errors.classification_complete); if (f.classification_complete !== complete || timing.module && timing.module.ordinal > binding.selected_modules) return null;
    return { schema_version: 1, kind: "p16-partial-suite-evidence", observation_point: point, diagnostic_only: true, acceptance: false, sealed: true, partial: true, capture_status: "captured", unavailable_reason: null, binding, failures: { selection: "lowest-two-admitted-tuples", observed: binding.counts.failed, retained: entries.length, omitted: binding.counts.failed - entries.length, classification_complete: complete, entries }, timing };
  } catch { return null; }
}
function p16Sample(value: unknown): P16Sample | null {
  const s = suiteExact(value, ["schema_version", "kind", "type", "sequence", "reporter_elapsed_ms", "module", "case_ordinal", "errors", "timing"]), module = s && p16Module(s.module); if (!s || s.schema_version !== 1 || s.kind !== "p16-suite-sample" || !suiteInteger(s.sequence, 50000, 1) || !p16Time(s.reporter_elapsed_ms) || !module) return null;
  const base = { schema_version: 1 as const, kind: "p16-suite-sample" as const, sequence: s.sequence, reporter_elapsed_ms: s.reporter_elapsed_ms, module };
  if (s.type === "failure") { const errors = p15SanitizeErrors(s.errors); return suiteInteger(s.case_ordinal, 20000, 1) && errors && s.timing === null ? { ...base, type: "failure", case_ordinal: s.case_ordinal, errors, timing: null } : null; }
  const timing = p16Timing(s.timing); return s.type === "module" && module.source === "runner/workflow-orchestrator.test.ts" && s.case_ordinal === null && s.errors === null && timing && (timing.capture_status === "unavailable" || timing.module?.ordinal === module.ordinal && timing.reporter_end_ms === s.reporter_elapsed_ms) ? { ...base, type: "module", case_ordinal: null, errors: null, timing } : null;
}
function p16ResultErrors(result: unknown, source: string): P15Errors {
  try {
    const input = p16Own(result, "errors"); if (input === undefined || input === null) return p15ErrorsUnavailable("missing-errors"); const errors = p15Array(input, 20000); if (!errors) return p15ErrorsUnavailable("invalid-errors");
    const messages: string[] = []; for (const error of errors) { const stack = p16Own(error, "stack"), message = stack || p16Own(error, "message"); if (!p15String(message, 65536)) return p15ErrorsUnavailable("invalid-errors"); messages.push(message); } return p15ProjectErrors(messages, source);
  } catch { return p15ErrorsUnavailable("invalid-errors"); }
}
function p16ReporterTiming(module: unknown, identity: P15Identity["module"], elapsed: number, state: SuiteProgressState): P16Timing {
  try { const d = suiteCall(module, "diagnostic"), values = { duration: p16Own(d, "duration"), environmentSetupDuration: p16Own(d, "environmentSetupDuration"), prepareDuration: p16Own(d, "prepareDuration"), collectDuration: p16Own(d, "collectDuration"), setupDuration: p16Own(d, "setupDuration") }; return p16Timing({ capture_status: "captured", unavailable_reason: null, measurement: "vitest-reported-inclusive-zero-fallback", module: identity, reporter_end_ms: elapsed, state, values }) ?? p16TimingUnavailable("invalid-sample"); } catch { return p16TimingUnavailable("invalid-sample"); }
}
/** One issued lane, bounded memory and permanent invalidity; construction is codec-free. */
function p16Lines<T>(marker: string, maximum: number, limit: number, parse: (value: unknown) => T | null, identity: (value: T) => string) {
  let line: number[] = [], discard = false, bytes = 0, invalid = false, sealed = false, decoder: TextDecoder | undefined; const rows: T[] = [], seen = new Set<string>();
  const reserved = () => { const text = String.fromCharCode(...line); return text.startsWith(marker.slice(0, marker.indexOf(" "))) || line.length > 0 && marker.startsWith(text); };
  const complete = () => { if (!reserved()) return; if (discard || rows.length >= limit) { invalid = true; return; } try { const text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(line)); if (!text.startsWith(marker)) { invalid = true; return; } const row = parse(suiteParseJson(text.slice(marker.length))); if (!row) { invalid = true; return; } const key = identity(row); if (seen.has(key)) { invalid = true; return; } seen.add(key); rows.push(row); } catch { invalid = true; } };
  return Object.freeze({ push(chunk: unknown): void { if (sealed || invalid) return; try { if (typeof chunk !== "string" && (!chunk || typeof chunk !== "object" || nodeTypes.isProxy(chunk) || !Buffer.isBuffer(chunk))) { invalid = true; return; } const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk as Buffer; bytes += data.length; if (bytes > 8388608) { invalid = true; return; } decoder ??= new TextDecoder("utf-8", { fatal: true }); decoder.decode(data, { stream: true }); for (const byte of data) { if (byte === 10) { if (!discard || reserved()) complete(); line = []; discard = false; if (invalid) return; } else if (!discard) { if (line.length < maximum - 1) line.push(byte); else { if (reserved()) invalid = true; discard = true; if (invalid) return; } } } } catch { invalid = true; } }, finish(): { status: "captured" | "missing" | "invalid"; rows: T[] } { if (!sealed) { sealed = true; try { decoder?.decode(); } catch { invalid = true; } if (line.length && reserved()) invalid = true; line = []; } if (invalid) return { status: "invalid", rows: [] }; const detached: T[] = []; for (const row of rows) { const next = parse(row); if (!next) return { status: "invalid", rows: [] }; detached.push(next); } return { status: rows.length ? "captured" : "missing", rows: detached }; } });
}
export function createP16SuiteSampleCollector() { let failures = 0; const sequences = new Set<number>(); return p16Lines(P16_SAMPLE_MARKER, 2048, 3, p16Sample, (s) => { if (sequences.has(s.sequence) || s.type === "failure" && ++failures > 2) throw new Error(); sequences.add(s.sequence); return s.type === "module" ? "module" : `failure:${s.module.ordinal}:${s.case_ordinal}`; }); }
export function createP16SuiteCandidateCollector() { return p16Lines(P16_CANDIDATE_MARKER, 4096, 1, (value) => sanitizeP16PartialSuiteReceipt(value, "controller-close"), () => "candidate"); }
interface P16IdentityLatch { invalid: boolean; failed_count: number; selected: P15Identity[] }
function p16Observe(latch: P16IdentityLatch, frame: SuiteProgressFrame): void { if (latch.invalid) return; try { if (frame.event !== "case-result" || frame.data.state !== "failed") return; latch.failed_count++; latch.selected.push({ module: { ordinal: frame.module!.ordinal, source: frame.module!.source }, case_ordinal: frame.case!.ordinal }); latch.selected.sort(p15Compare); if (latch.selected.length > 2) latch.selected.pop(); } catch { latch.invalid = true; } }
function p16Base(report: SuiteWorkflowTimingDiagnosticReport, latch: P16IdentityLatch, point: P16PartialSuiteReceipt["observation_point"]): P16PartialSuiteReceipt {
  if (!["failed", "deadline"].includes(report.status) || report.json !== null) return p16Unavailable("not-target-report", point);
  const p = report.progress; if (!p || p.availability !== "available" || p.observed_modules < 1) return p16Unavailable("invalid-state", point);
  const fingerprint = report.source_drift === false ? p15Fingerprint(report.source_hashes) : null, after = fingerprint ? p15Fingerprint(report.source_hashes_after) : null;
  if (latch.invalid || !fingerprint || after !== fingerprint || !suiteInteger(latch.failed_count, 20000) || latch.failed_count !== p.counts.failed || latch.selected.length !== Math.min(2, latch.failed_count)) return p16Unavailable("invalid-state", point);
  const entries = latch.selected.map((e) => ({ module: { ...e.module }, case_ordinal: e.case_ordinal, errors: p15ErrorsUnavailable("missing-errors") }));
  return sanitizeP16PartialSuiteReceipt({ schema_version: 1, kind: "p16-partial-suite-evidence", observation_point: point, diagnostic_only: true, acceptance: false, sealed: true, partial: true, capture_status: "captured", unavailable_reason: null, binding: { source_fingerprint: fingerprint, progress_sequence: p.sequence, original_status: report.status, selected_modules: p.module_count, observed_modules: p.observed_modules, ended_modules: p.ended_modules, counts: { ...p.counts }, run_end_seen: p.run_end !== null }, failures: { selection: "lowest-two-admitted-tuples", observed: latch.failed_count, retained: entries.length, omitted: latch.failed_count - entries.length, classification_complete: false, entries }, timing: p16TimingUnavailable("missing-sample") }, point) ?? p16Unavailable("invalid-state", point);
}
interface P16ControllerState extends P16IdentityLatch { emitted: boolean; sampleInvalid: boolean; collector: ReturnType<typeof createP16SuiteSampleCollector>; samples: Map<string, { source: string; sequence: number; elapsed: number }>; moduleEnd: { ordinal: number; sequence: number; elapsed: number; state: string } | null; receipt: P16PartialSuiteReceipt | null }
function createP16ControllerState(): P16ControllerState { return { invalid: false, failed_count: 0, selected: [], emitted: false, sampleInvalid: false, collector: createP16SuiteSampleCollector(), samples: new Map(), moduleEnd: null, receipt: null }; }
function p16ControllerFrame(state: P16ControllerState, frame: SuiteProgressFrame): void {
  if (state.receipt || state.invalid) return; p16Observe(state, frame);
  if (frame.event === "case-result" && frame.data.state === "failed" && state.samples.size < 2) state.samples.set(`${frame.module!.ordinal}:${frame.case!.ordinal}`, { source: frame.module!.source, sequence: frame.sequence, elapsed: frame.reporter_elapsed_ms! });
  if (frame.event === "module-end" && frame.module!.source === "runner/workflow-orchestrator.test.ts") state.moduleEnd = { ordinal: frame.module!.ordinal, sequence: frame.sequence, elapsed: frame.reporter_elapsed_ms!, state: frame.data.state };
}
function p16ControllerSeal(state: P16ControllerState, report: SuiteWorkflowTimingDiagnosticReport): void {
  if (state.receipt) return; const base = p16Base(report, state, "controller-close"); state.receipt = base; if (base.capture_status !== "captured") return;
  const captured = state.collector.finish(); if (state.sampleInvalid || captured.status === "invalid") { base.failures!.entries.forEach((e) => { e.errors = p15ErrorsUnavailable("invalid-errors"); }); base.timing = p16TimingUnavailable("invalid-transport"); return; }
  let errorSamples = 0, moduleSamples = 0;
  for (const sample of captured.rows) {
    if (sample.type === "failure") { const bound = state.samples.get(`${sample.module.ordinal}:${sample.case_ordinal}`); if (++errorSamples > 2 || !bound || bound.source !== sample.module.source || bound.sequence !== sample.sequence || bound.elapsed !== sample.reporter_elapsed_ms) { base.timing = p16TimingUnavailable("invalid-binding"); base.failures!.entries.forEach((e) => { e.errors = p15ErrorsUnavailable("invalid-errors"); }); base.failures!.classification_complete = false; return; }
      const entry = base.failures!.entries.find((e) => e.module.ordinal === sample.module.ordinal && e.module.source === sample.module.source && e.case_ordinal === sample.case_ordinal); if (entry) entry.errors = sample.errors!;
    } else { const end = state.moduleEnd; if (++moduleSamples > 1 || !end || sample.sequence !== end.sequence || sample.module.ordinal !== end.ordinal || sample.reporter_elapsed_ms !== end.elapsed || sample.timing!.capture_status === "captured" && sample.timing!.state !== end.state) { base.timing = p16TimingUnavailable("invalid-binding"); continue; } base.timing = sample.timing; }
  }
  base.failures!.classification_complete = base.failures!.observed > 0 && base.failures!.omitted === 0 && base.failures!.entries.every((e) => e.errors.capture_status === "captured" && e.errors.classification_complete);
}
interface P16ParentState { target: boolean; invalid: boolean; collector: ReturnType<typeof createP16SuiteCandidateCollector>; receipt: P16PartialSuiteReceipt | null }
function sealP16Partial(state: ObservationLossState, report: SuiteWorkflowTimingDiagnosticReport): P16PartialSuiteReceipt {
  if (state.receipt?.capture_status !== "captured" || state.failures.invalid) return p16Unavailable("invalid-state");
  if (state.receipt.first_rejection !== null || state.receipt.terminal?.branch !== "report-returned") return p16Unavailable("not-target-report");
  const base = p16Base(report, state.failures, "watchdog-return"); if (base.capture_status !== "captured") return base; state.partial.target = true;
  let captured: ReturnType<ReturnType<typeof createP16SuiteCandidateCollector>["finish"]>;
  try { captured = state.partial.collector.finish(); } catch { captured = { status: "invalid", rows: [] }; }
  const candidate = state.partial.invalid ? undefined : captured.rows[0]; let reason: P16DetailReason | null = state.partial.invalid || captured.status === "invalid" ? "invalid-transport" : !candidate ? "missing-candidate" : null;
  if (candidate && (candidate.capture_status !== "captured" || JSON.stringify(candidate.binding) !== JSON.stringify(base.binding) || candidate.failures!.entries.some((e, index) => { const bound = base.failures!.entries[index]; return !bound || p15Compare(e, bound) !== 0 || e.module.source !== bound.module.source; }))) reason = "invalid-binding";
  if (reason) { base.timing = p16TimingUnavailable(reason); if (reason !== "missing-candidate") base.failures!.entries.forEach((e) => { e.errors = p15ErrorsUnavailable("invalid-errors"); }); return base; }
  base.failures = candidate!.failures; const timing = candidate!.timing!, workflow = report.workflow_cases;
  base.timing = timing.capture_status === "unavailable" ? timing : workflow?.availability === "available" && workflow.module !== null && timing.module !== null && workflow.module.ordinal === timing.module.ordinal && workflow.module.source === timing.module.source && workflow.window !== null && workflow.window.end_ms === timing.reporter_end_ms && workflow.window.state === timing.state ? timing : p16TimingUnavailable("invalid-binding");
  return sanitizeP16PartialSuiteReceipt(base) ?? p16Unavailable("invalid-state");
}
export function formatP16PartialSuiteLine(value: unknown, originalReportLine: string, p13Line: string): string | null {
  try { const safe = sanitizeP16PartialSuiteReceipt(value); if (!safe || typeof originalReportLine !== "string" || !originalReportLine.endsWith("\n") || typeof p13Line !== "string" || !p13Line.startsWith("P12_OBSERVATION_LOSS_PROFILE ") || !p13Line.endsWith("\n")) return null;
    const line = `${P16_PARTIAL_MARKER}${JSON.stringify(safe)}\n`, bytes = Buffer.byteLength(line), prior = Buffer.byteLength(p13Line), wrapper = Buffer.byteLength('{"role":"suite-workflow-timing-report","report":') + 1;
    return bytes <= 4096 && prior <= 2048 && Buffer.byteLength(originalReportLine) + wrapper + prior + bytes <= 131072 ? line : null;
  } catch { return null; }
}

interface ObservationLossState {
  claimed: boolean; sealed: boolean; emitted: boolean; invalid: boolean; report: SuiteWorkflowTimingDiagnosticReport | null;
  first: ObservationLossRejection | null; receipt: P12ObservationLossReceipt | null;
  deltaInvalid: boolean; delta: P14DeltaObservation | null; deltaReceipt: P14DeltaRejectionReceipt | null;
  failures: P15ParentState;
  partial: P16ParentState;
}
function sealDeltaRejection(state: ObservationLossState): P14DeltaRejectionReceipt {
  if (state.deltaInvalid || state.receipt?.capture_status !== "captured") return deltaRejectionUnavailable("invalid-state");
  const first = state.receipt.first_rejection;
  if (!first || first.site !== "delta-envelope-or-time") return deltaRejectionUnavailable("not-target-rejection");
  if (!state.delta || state.delta.role !== first.role || state.delta.counted_messages !== first.counted_messages) return deltaRejectionUnavailable("invalid-state");
  return sanitizeP14DeltaRejectionReceipt({ schema_version: 1, kind: "p14-delta-rejection", observation_point: "watchdog-return", diagnostic_only: true, acceptance: false, sealed: true, capture_status: "captured", unavailable_reason: null, delta: state.delta }) ?? deltaRejectionUnavailable("invalid-state");
}
const observationLossHandles = new WeakMap<object, ObservationLossState>();
function claimObservationLoss(handle: unknown): ObservationLossState | null {
  if (!handle || typeof handle !== "object") return null;
  const state = observationLossHandles.get(handle); if (!state || state.claimed) return null; state.claimed = true; return state;
}
/** A report-reference binding, never a caller-supplied logger or execution grant. */
export function createP12ObservationLossCapture() {
  const handle = Object.freeze({}), state: ObservationLossState = { claimed: false, sealed: false, emitted: false, invalid: false, report: null, first: null, receipt: null, deltaInvalid: false, delta: null, deltaReceipt: null,
    failures: { invalid: false, target: false, failed_count: 0, selected: [], collector: createP15SuiteFailureCollector(), receipt: null }, partial: { target: false, invalid: false, collector: createP16SuiteCandidateCollector(), receipt: null } };
  observationLossHandles.set(handle, state);
  const read = (report: unknown): P12ObservationLossReceipt => {
    if (!state.sealed) return observationLossUnavailable("incomplete-observation");
    if (report !== state.report) return observationLossUnavailable("invalid-binding");
    return sanitizeP12ObservationLossReceipt(state.receipt) ?? observationLossUnavailable("invalid-state");
  };
  const readDelta = (report: unknown): P14DeltaRejectionReceipt => {
    if (!state.sealed) return deltaRejectionUnavailable("incomplete-observation");
    if (report !== state.report) return deltaRejectionUnavailable("invalid-binding");
    try { return sanitizeP14DeltaRejectionReceipt(state.deltaReceipt) ?? deltaRejectionUnavailable("invalid-state"); }
    catch { return deltaRejectionUnavailable("invalid-state"); }
  };
  const readFailures = (report: unknown): P15SuiteFailuresReceipt => {
    if (!state.sealed) return p15Unavailable("incomplete-observation");
    if (report !== state.report) return p15Unavailable("invalid-binding");
    try { return sanitizeP15SuiteFailuresReceipt(state.failures.receipt) ?? p15Unavailable("invalid-state"); } catch { return p15Unavailable("invalid-state"); }
  };
  const readPartial = (report: unknown): P16PartialSuiteReceipt => {
    if (!state.sealed) return p16Unavailable("incomplete-observation");
    if (report !== state.report) return p16Unavailable("invalid-binding");
    try { return sanitizeP16PartialSuiteReceipt(state.partial.receipt) ?? p16Unavailable("invalid-state"); } catch { return p16Unavailable("invalid-state"); }
  };
  return Object.freeze({
    handle, read, readDelta, readFailures, readPartial,
    emit(report: unknown, originalReportLine: string, write: (line: string) => unknown = (line) => process.stderr.write(line)): void {
      if (!state.sealed || report !== state.report || state.emitted) return; state.emitted = true;
      let p13Line: string | null = null;
      try { const line = formatP12ObservationLossLine(read(report), originalReportLine); if (line !== null) { write(line); p13Line = line; } } catch { /* Best effort, one attempt, no effect on original stdout/exit. */ }
      if (p13Line === null) return;
      let p14Attempted = false;
      try { const line = formatP14DeltaRejectionLine(readDelta(report), originalReportLine, p13Line); if (line !== null) { p14Attempted = true; write(line); } } catch { /* Additional synchronous failure never retries or changes P13. */ }
      if (p14Attempted) return;
      if (state.failures.target) { try { const line = formatP15SuiteFailuresLine(readFailures(report), originalReportLine, p13Line); if (line !== null) write(line); } catch { /* P15 never changes old attempts or retries a write. */ } return; }
      if (state.deltaReceipt?.capture_status === "captured" || !state.partial.target) return;
      try { const line = formatP16PartialSuiteLine(readPartial(report), originalReportLine, p13Line); if (line !== null) write(line); } catch { /* P16 has no fallback/retry or authority over old output. */ }
    },
  });
}
/** Original report is already serialized by the CLI; do not serialize it again. */
export function formatP12ObservationLossLine(value: unknown, originalReportLine: string): string | null {
  try {
    const receipt = sanitizeP12ObservationLossReceipt(value); if (!receipt || typeof originalReportLine !== "string" || !originalReportLine.endsWith("\n")) return null;
    const line = `P12_OBSERVATION_LOSS_PROFILE ${JSON.stringify(receipt)}\n`, bytes = Buffer.byteLength(line);
    const wrapperBytes = Buffer.byteLength('{"role":"suite-workflow-timing-report","report":') + 1;
    return bytes <= 2048 && Buffer.byteLength(originalReportLine) + wrapperBytes + bytes <= 131072 ? line : null;
  } catch { return null; }
}

/** P13 has priority; inputs are already serialized, not replayed message data. */
export function formatP14DeltaRejectionLine(value: unknown, originalReportLine: string, p13Line: string): string | null {
  try {
    const receipt = sanitizeP14DeltaRejectionReceipt(value);
    if (!receipt || receipt.capture_status !== "captured" || typeof originalReportLine !== "string" || !originalReportLine.endsWith("\n") || typeof p13Line !== "string" || !p13Line.startsWith("P12_OBSERVATION_LOSS_PROFILE ") || !p13Line.endsWith("\n")) return null;
    const line = `P14_DELTA_REJECTION_PROFILE ${JSON.stringify(receipt)}\n`, bytes = Buffer.byteLength(line), priorBytes = Buffer.byteLength(p13Line);
    const wrapperBytes = Buffer.byteLength('{"role":"suite-workflow-timing-report","report":') + 1;
    return bytes <= 2048 && priorBytes <= 2048 && Buffer.byteLength(originalReportLine) + wrapperBytes + priorBytes + bytes <= 131072 ? line : null;
  } catch { return null; }
}

interface WorkflowTimingControllerChild extends SupervisedChild { on(event: "message", listener: (value: unknown) => void): unknown; send(message: { role: "suite-workflow-timing-controller"; origin_ms: number }): unknown }
/** Independent private replay; no filesystem or unissued process access in the watchdog. */
export async function runSuiteWorkflowTimingDiagnosticWatchdog(deadline = new ProfileDeadline(), launch: () => WorkflowTimingControllerChild = () => fork(script, [], { cwd: repository, execArgv: ["--import", "tsx"], env: profileEnvironment(process.env), stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true }), observationHandle?: unknown): Promise<SuiteWorkflowTimingDiagnosticReport> {
  const observation = claimObservationLoss(observationHandle);
  let validatedFrameSequence = 0, supervision: ObservationLossTerminal["controller_supervision"] = null;
  const finish = (report: SuiteWorkflowTimingDiagnosticReport, branch: ObservationLossBranch): SuiteWorkflowTimingDiagnosticReport => {
    if (observation && !observation.sealed) {
      observation.sealed = true; observation.report = report;
      try { observation.receipt = observation.invalid ? observationLossUnavailable("invalid-state") : sanitizeP12ObservationLossReceipt({ schema_version: 1, kind: "p12-observation-loss", observation_point: "watchdog-return", diagnostic_only: true, acceptance: false, sealed: true, capture_status: "captured", unavailable_reason: null, first_rejection: observation.first, terminal: { branch, original_status: report.status, controller_supervision: supervision } }) ?? observationLossUnavailable("invalid-state"); }
      catch { observation.invalid = true; }
      try { observation.deltaReceipt = sealDeltaRejection(observation); }
      catch { observation.deltaInvalid = true; observation.deltaReceipt = deltaRejectionUnavailable("invalid-state"); }
      try { observation.failures.receipt = sealP15Failures(observation, report); }
      catch { observation.failures.invalid = true; observation.failures.receipt = p15Unavailable("invalid-state"); }
      try { observation.partial.receipt = sealP16Partial(observation, report); }
      catch { observation.partial.receipt = p16Unavailable("invalid-state"); }
    }
    return report;
  };
  if (!deadline.mayLaunch()) {
    if (observation) observation.first = { site: "budget-before-launch", role: null, counted_messages: 0, accounted_ipc_bytes: 0, validated_frame_sequence: 0, frame_sequence: null, source_seen: false, source_valid: false, final_seen: false, final_valid: false, receipt_set_revoked: false };
    return finish(workflowTimingUnavailable(deadline, true), "budget-before-launch");
  }
  const projection = createSuiteProgressProjection(), costs = createSuiteAttributionCosts(), workflow = createWorkflowCaseTimingProjection();
  let source: SuiteWorkflowTimingSourceMetadata | null = null, sourceSeen = false, finalSeen = false, revoked = false, final: SuiteWorkflowTimingDiagnosticReport | null = null;
  let receipt: PlannerSpanReceipt | null = null, wait: PlannerWaitReceipt | null = null, continuity: PlannerContinuityReceipt | null = null, receiptSeen = false, waitSeen = false, continuitySeen = false, receiptsRevoked = false;
  let exit: SuiteProgressDiagnosticReport["native_exit"] = null, received: number | null = null, lastDelivery = 0, messages = 0, bytes = 0;
  const reject = (site: ObservationLossSite, data: Record<string, unknown> | null = null, frame: SuiteProgressFrame | null = null, deltaCondition: P14DeltaCondition | null = null, previousDeliveryMs: number | null = null, parentElapsedMs: number | null = null): void => {
    if (!observation || observation.sealed || observation.first) return;
    try {
      const role = data?.role;
      const alias: ObservationLossRole = data === null ? null : role === "suite-workflow-timing-source" ? "source" : role === "suite-workflow-timing-frame" ? "frame" : role === "suite-workflow-timing-receipt" ? "p09" : role === "suite-workflow-timing-wait" ? "p11" : role === "suite-workflow-timing-continuity" ? "p12" : role === "suite-workflow-timing-receipts-unavailable" ? "receipts-unavailable" : role === "suite-workflow-timing-exit" ? "exit" : role === "suite-workflow-timing-report" ? "final" : "other";
      observation.first = { site, role: alias, counted_messages: messages, accounted_ipc_bytes: bytes, validated_frame_sequence: validatedFrameSequence, frame_sequence: frame?.sequence ?? null, source_seen: sourceSeen, source_valid: source !== null, final_seen: finalSeen, final_valid: final !== null, receipt_set_revoked: receiptsRevoked };
    } catch { observation.invalid = true; }
    if (site === "delta-envelope-or-time" && observation.first) {
      try {
        if (deltaCondition === null) { observation.deltaInvalid = true; return; }
        const measured = deltaCondition === "delivery-regression" || deltaCondition === "after-parent-elapsed";
        observation.delta = { condition: deltaCondition, role: observation.first.role as P14DeltaObservation["role"], counted_messages: observation.first.counted_messages,
          received_ms: measured ? data!.received_ms as number : null, previous_delivery_ms: measured ? previousDeliveryMs : null, parent_elapsed_ms: deltaCondition === "after-parent-elapsed" ? parentElapsedMs : null };
      } catch { observation.deltaInvalid = true; }
    }
  };
  const unavailable = (expired: boolean) => { const report = workflowTimingUnavailable(deadline, expired); if (!revoked) { report.source_hashes = source?.source_hashes ?? {}; report.progress = compactSuiteProgress(projection.snapshot()); report.costs = costs.snapshot(); report.workflow_cases = workflow.snapshot(); report.last_progress_received_ms = report.progress ? received : null; report.receipt = receipt; report.wait_receipt = wait; report.continuity_receipt = continuity; report.native_exit = exit; } return report; };
  try {
    const controller = launch(), cancellation = new AbortController(), pending = superviseChild(controller, deadline, 1000, cancellation.signal, "cleanup");
    controller.stdout?.on?.("data", () => {}); controller.stderr?.on?.("data", (chunk) => { if (!observation || observation.sealed) return; try { observation.failures.collector.push(chunk); } catch { observation.failures.invalid = true; } try { observation.partial.collector.push(chunk); } catch { observation.partial.invalid = true; } });
    controller.on("message", (value) => {
      if (revoked) return;
      let currentFrame: SuiteProgressFrame | null = null;
      try {
        const data = suiteRecord(value, 4); if (!data || finalSeen || ++messages > 50008) { reject(!data ? "message-envelope" : finalSeen ? "message-after-final" : "message-count", data); revoked = true; return; }
        if (data.role === "suite-workflow-timing-source") { if (sourceSeen) { reject("source-duplicate", data); revoked = true; return; } sourceSeen = true; source = sanitizeSuiteWorkflowTimingSourceMetadata(value); if (!source) { reject("source-invalid", data); revoked = true; return; } bytes += Buffer.byteLength(JSON.stringify(source)); return; }
        if (!source) { reject("source-required", data); revoked = true; return; }
        if (["suite-workflow-timing-frame", "suite-workflow-timing-receipt", "suite-workflow-timing-wait", "suite-workflow-timing-continuity"].includes(data.role as string)) {
          const frameKind = data.role === "suite-workflow-timing-frame", keys = frameKind ? ["role", "frame", "received_ms"] : ["role", "receipt", "received_ms"];
          let deltaCondition: P14DeltaCondition = "envelope-shape", previousDeliveryMs: number | null = null, parentElapsedMs: number | null = null;
          if (!suiteExact(value, keys) || (deltaCondition = "received-ms-range", !spanTime(data.received_ms)) || (deltaCondition = "delivery-regression", data.received_ms < (previousDeliveryMs = lastDelivery)) || (deltaCondition = "after-parent-elapsed", data.received_ms > (parentElapsedMs = deadline.elapsed()))) { reject("delta-envelope-or-time", data, null, deltaCondition, previousDeliveryMs, parentElapsedMs); revoked = true; return; } lastDelivery = data.received_ms;
          if (frameKind) {
            const frame = sanitizeSuiteProgressFrame(data.frame); currentFrame = frame; let site: ObservationLossSite = "frame-invalid";
            if (!frame || (site = "progress-replay", !projection.accept(frame)) || (site = "costs-replay", !costs.accept(frame)) || (site = "workflow-replay", !workflow.accept(frame))) { reject(site, data, frame); revoked = true; return; }
            try { p15ObserveFrame(observation, frame); } catch { if (observation) observation.failures.invalid = true; }
            validatedFrameSequence = frame.sequence; received = data.received_ms; bytes += Buffer.byteLength(JSON.stringify(frame)) + 128;
          }
          else {
            if (receiptsRevoked) { reject("receipt-after-revocation", data); revoked = true; return; }
            if (data.role === "suite-workflow-timing-receipt") { if (receiptSeen) { reject("p09-duplicate", data); revoked = true; return; } receiptSeen = true; receipt = sanitizePlannerSpanReceipt(data.receipt, source.sourceLimits); if (!receipt) { reject("p09-invalid", data); revoked = true; return; } bytes += Buffer.byteLength(JSON.stringify(receipt)) + 128; }
            else if (data.role === "suite-workflow-timing-wait") { if (waitSeen) { reject("p11-duplicate", data); revoked = true; return; } waitSeen = true; wait = sanitizePlannerWaitReceipt(data.receipt); if (!wait) { reject("p11-invalid", data); revoked = true; return; } bytes += Buffer.byteLength(JSON.stringify(wait)) + 128; }
            else { if (continuitySeen) { reject("p12-duplicate", data); revoked = true; return; } continuitySeen = true; continuity = sanitizePlannerContinuityReceipt(data.receipt); if (!continuity) { reject("p12-invalid", data); revoked = true; return; } bytes += Buffer.byteLength(JSON.stringify(continuity)) + 128; }
          }
        } else if (data.role === "suite-workflow-timing-receipts-unavailable") {
          if (!suiteExact(value, ["role"]) || receiptsRevoked) { reject("receipt-revocation-envelope-or-duplicate", data); revoked = true; return; } receiptsRevoked = true; receipt = null; wait = null; continuity = null; bytes += 128;
        } else if (data.role === "suite-workflow-timing-exit") { if (!suiteExact(value, ["role", "native_exit"]) || exit) { reject("exit-envelope-or-duplicate", data); revoked = true; return; } exit = suiteExit(data.native_exit); if (!exit || exit.received_ms < lastDelivery || exit.received_ms > deadline.elapsed()) { reject("exit-invalid-or-time", data); revoked = true; return; } lastDelivery = exit.received_ms; bytes += 256; }
        else if (data.role === "suite-workflow-timing-report") {
          if (!suiteExact(value, ["role", "report"])) { reject("final-envelope", data); revoked = true; return; } finalSeen = true;
          const report = sanitizeSuiteWorkflowTimingDiagnostic(data.report, source.sourceLimits, { progress: projection.snapshot(), costs: costs.snapshot(), workflow_cases: workflow.snapshot() });
          if (!report || report.wall_ms < lastDelivery || report.wall_ms > deadline.elapsed() || sourceHashesChanged(source.source_hashes, report.source_hashes) || JSON.stringify(report.receipt) !== JSON.stringify(receipt) || JSON.stringify(report.wait_receipt) !== JSON.stringify(wait) || JSON.stringify(report.continuity_receipt) !== JSON.stringify(continuity) || JSON.stringify(report.native_exit) !== JSON.stringify(exit) || report.last_progress_received_ms !== received) { reject(report ? "final-binding" : "final-sanitizer", data); revoked = true; return; }
          final = report; bytes += Buffer.byteLength(JSON.stringify({ role: "suite-workflow-timing-report", report }));
        } else { reject("message-role", data); revoked = true; return; }
        if (bytes > SUITE_PROGRESS_LIMITS.stderr_bytes + 2 * SUITE_PROGRESS_LIMITS.snapshot_bytes + 50000 * 128) { reject("ipc-byte-limit", data, currentFrame); revoked = true; }
      } catch { reject("message-handler-exception", null, currentFrame); revoked = true; }
    });
    try { controller.send({ role: "suite-workflow-timing-controller", origin_ms: performance.timeOrigin }); } catch { reject("controller-send-exception"); cancellation.abort(); }
    const outcome = await pending, report = final as SuiteWorkflowTimingDiagnosticReport | null;
    supervision = outcome; let branch: ObservationLossBranch = "revoked";
    if (revoked || (branch = "controller-not-closed", !outcome.closed) || (branch = "controller-expired", outcome.expired) || (branch = "controller-supervision-failed", outcome.failed) || (branch = "controller-exit-nonzero", outcome.exit_code !== 0) || (branch = "final-missing", !report) || (branch = "return-budget", deadline.remaining() <= 0)) return finish(unavailable(outcome.expired || deadline.remaining() <= 0), branch);
    report.wall_ms = deadline.elapsed(); return finish(report, "report-returned");
  } catch { reject("watchdog-exception"); return finish(unavailable(deadline.remaining() <= 0), "watchdog-exception"); }
}
async function suiteWorkflowTimingControllerWorker(value: unknown): Promise<void> {
  try {
    const data = suiteExact(value, ["role", "origin_ms"]); if (!data || data.role !== "suite-workflow-timing-controller" || !finite(data.origin_ms)) throw new Error();
    const origin = data.origin_ms, deadline = new ProfileDeadline(() => performance.timeOrigin + performance.now() - origin); let deliveryUnavailable = false;
    const send = (message: unknown): void => { if (deliveryUnavailable || !process.send || !process.connected) throw new Error(); const queued = process.send(message, (error) => { if (error) deliveryUnavailable = true; }); if (!queued) { deliveryUnavailable = true; throw new Error(); } };
    const failures = createP15ControllerCapture();
    const report = await runLoadedSuiteWorkflowTiming(deadline, send, (message) => { try { send(message); } catch { deliveryUnavailable = true; } }, failures.handle);
    if (deliveryUnavailable || !process.send || !process.connected) throw new Error();
    process.send({ role: "suite-workflow-timing-report", report }, (error) => { if (process.connected) process.disconnect(); process.exitCode = error ? 1 : 0; });
    failures.emit(report);
  } catch { if (process.connected) process.disconnect(); process.exitCode = 1; }
}

export class ProfileDeadline {
  constructor(private readonly clock: () => number = () => performance.now(), private readonly started = 0) {}
  remaining(): number { return Math.max(0, PROFILE_LIMIT_MS - (this.clock() - this.started)); }
  workRemaining(): number { return Math.max(0, this.remaining() - PROFILE_CLEANUP_RESERVE_MS); }
  mayLaunch(): boolean { return this.workRemaining() > 0; }
  elapsed(): number { return Math.max(0, this.clock() - this.started); }
}

export function profileEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]);
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) if (allowed.has(key.toUpperCase()) && value !== undefined) result[key] = value;
  // Never forward NODE_OPTIONS, authentication, provider flags, user state, or Git overrides.
  result.NO_COLOR = "1"; result.CI = "1"; return result;
}
export function fixtureProfileEnvironment(workload: ProfileWorkload, mode: Sample["mode"], source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = profileEnvironment(source);
  if (workload === "first-planner" && mode === "phases") env.SURTEC_TEST_PLANNER_PROFILE = "1";
  return env;
}

/** Observer preserves this/arguments, exact return identity and exact thrown identity. */
const observations = new WeakMap<() => void, { failed: boolean }>();
export function observationComplete(restore: () => void): boolean { return observations.get(restore)?.failed === false; }
export function observeFunctionCalls(target: object, names: readonly string[], count: (operation: string) => void, timing?: { clock: () => number; observe: (operation: string, elapsed_ms: number) => void }): () => void {
  const restorations: Array<() => void> = [], health: { failed: boolean; last_clock?: number } = { failed: false };
  const clock = () => { const value = timing!.clock(); if (!Number.isFinite(value) || health.last_clock !== undefined && value < health.last_clock) health.failed = true; else health.last_clock = value; return value; };
  try {
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" || !descriptor.configurable) throw new Error("Observation target unavailable.");
      const original = descriptor.value as (...args: unknown[]) => unknown;
      const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        let started: number | undefined;
        try { count(name); } catch { health.failed = true; }
        if (timing) try { started = clock(); } catch { health.failed = true; }
        try { return Reflect.apply(original, this, args); }
        finally {
          if (started !== undefined && Number.isFinite(started)) try {
            const ended = timing ? clock() : undefined;
            if (ended !== undefined && Number.isFinite(ended) && ended >= started) timing?.observe(name, ended - started);
            else health.failed = true;
          } catch { health.failed = true; }
        }
      };
      Object.defineProperty(target, name, { ...descriptor, value: wrapper });
      restorations.push(() => Object.defineProperty(target, name, descriptor));
    }
  } catch (error) { for (const restore of restorations.reverse()) restore(); throw error; }
  let active = true;
  const restore = () => { if (active) { active = false; for (const undo of restorations.reverse()) undo(); } };
  observations.set(restore, health); return restore;
}

interface OwnedRoot { path: string; token: string; dev: number | bigint; ino: number | bigint }
const ownedRoots = new WeakMap<object, OwnedRoot>();
const uninspectedRoots = new Set<string>();
export function uninspectedOwnedRootCount(): number { return uninspectedRoots.size; }
function cleanupBudget(deadline?: ProfileDeadline): void { if (deadline && deadline.remaining() <= 0) throw new Error("Cleanup deadline reached."); }
function safeAncestors(path: string, deadline?: ProfileDeadline): void {
  let current = path;
  for (;;) { cleanupBudget(deadline); const stat = fs.lstatSync(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Owned boundary unavailable."); if (dirname(current) === current) return; current = dirname(current); }
}
export function createOwnedProfileRoot(): OwnedRoot {
  safeAncestors(resolve(tmpdir()));
  const token = randomUUID(), path = fs.mkdtempSync(join(resolve(tmpdir()), PREFIX));
  // A returned name with unavailable initial identity cannot be adopted/deleted.
  uninspectedRoots.add(path);
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Owned boundary unavailable.");
  const owned = Object.freeze({ path, token, dev: stat.dev, ino: stat.ino }); ownedRoots.set(owned, { ...owned }); uninspectedRoots.delete(path); return owned;
}
function safeTree(path: string, deadline?: ProfileDeadline): void {
  cleanupBudget(deadline);
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw new Error("Cleanup boundary unavailable.");
  if (stat.isDirectory()) { cleanupBudget(deadline); for (const entry of fs.readdirSync(path)) safeTree(join(path, entry), deadline); }
}
export function cleanupOwnedRoot(owned: OwnedRoot, writersCertain: boolean, deadline?: ProfileDeadline): boolean {
  if (!writersCertain || !ownedRoots.has(owned)) return false;
  const absolute = resolve(owned.path), parent = resolve(tmpdir());
  if (absolute !== owned.path || dirname(absolute) !== parent || !basename(absolute).startsWith(PREFIX)) return false;
  try {
    // Verify every current ancestor before the exact owned recursive target is removed.
    safeAncestors(absolute, deadline); cleanupBudget(deadline);
    const stat = fs.lstatSync(absolute);
    if (stat.dev !== owned.dev || stat.ino !== owned.ino) return false;
    safeTree(absolute, deadline); cleanupBudget(deadline);
    if (fs.readFileSync(join(absolute, ".profile-owner"), "utf8") !== owned.token) return false;
    cleanupBudget(deadline); fs.rmSync(absolute, { recursive: true }); cleanupBudget(deadline);
    const removed = !fs.existsSync(absolute); cleanupBudget(deadline); if (removed) ownedRoots.delete(owned); return removed;
  } catch { return false; }
}

export interface SupervisedChild {
  once(event: "close", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: () => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  readonly stdout?: { destroy(): unknown; on?(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  readonly stderr?: { destroy(): unknown; on?(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  readonly connected?: boolean;
  readonly channel?: { unref(): unknown } | null;
  disconnect?(): unknown;
  unref?(): unknown;
}
/** Detach only owned references; no cleanup or descendant quiescence is implied. */
export function detachOwnedChild(child: SupervisedChild): void {
  for (const operation of [() => child.stdout?.destroy(), () => child.stderr?.destroy(), () => { if (child.connected) child.disconnect?.(); }, () => child.channel?.unref(), () => child.unref?.()]) {
    try { operation(); } catch { /* Unknown exit/writers stay unavailable. */ }
  }
}
/** Only the actual issued handle is stopped. A stopped handle is not descendant proof. */
export async function superviseChild(child: SupervisedChild, deadline: ProfileDeadline, shutdownMs = 1000, stopSignal?: AbortSignal, phase: "work" | "cleanup" = "work"): Promise<{ exit_code: number | null; closed: boolean; expired: boolean; failed: boolean }> {
  return new Promise((done) => {
    let finished = false, stopping = false, expired = false, failed = false, stopTimer: ReturnType<typeof setTimeout> | undefined, hardTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exit_code: number | null, closed: boolean) => {
      if (finished) return; finished = true; clearTimeout(workTimer); clearTimeout(stopTimer); clearTimeout(hardTimer); stopSignal?.removeEventListener("abort", abort); if (!closed) detachOwnedChild(child); done({ exit_code, closed, expired, failed });
    };
    const stop = (deadlineReached: boolean) => {
      if (finished || stopping) return; stopping = true; expired = deadlineReached;
      clearTimeout(workTimer);
      try { child.kill("SIGTERM"); } catch { failed = true; }
      if (finished) return;
      const available = deadline.remaining();
      if (available <= 0) { finish(null, false); return; }
      hardTimer = setTimeout(() => { if (!finished) { try { child.kill("SIGKILL"); } catch { failed = true; } } }, Math.min(shutdownMs, available));
      stopTimer = setTimeout(() => finish(null, false), Math.min(shutdownMs * 2, available));
    };
    // The outer watchdog permits the controller's reserved cleanup, but keeps its
    // own bounded TERM/KILL grace inside the same original wall deadline.
    const workTimer = setTimeout(() => stop(true), phase === "cleanup" ? Math.max(0, deadline.remaining() - shutdownMs * 2) : deadline.workRemaining());
    const abort = () => { failed = true; stop(false); };
    child.once("close", (code) => finish(code, true));
    child.once("error", () => { failed = true; stop(false); });
    stopSignal?.addEventListener("abort", abort, { once: true }); if (stopSignal?.aborted) abort();
  });
}

function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
export function summarizeVitestOutput(output: string, expected: number): { passed: boolean; test_ms: number; tests: number } {
  // Reporter stdout may have an unrelated prefix; raw output never leaves this process.
  try {
    const start = output.search(/\{\s*"numTotalTestSuites"\s*:/);
    if (start < 0) return { passed: false, test_ms: 0, tests: 0 };
    const value: unknown = JSON.parse(output.slice(start));
    if (!value || typeof value !== "object") throw new Error();
    const data = value as { success?: unknown; numFailedTests?: unknown; testResults?: unknown };
    if (!Array.isArray(data.testResults)) throw new Error();
    let test_ms = 0, tests = 0, passed = data.success === true && data.numFailedTests === 0;
    for (const item of data.testResults) {
      if (!item || typeof item !== "object" || !Array.isArray(item.assertionResults)) throw new Error();
      for (const entry of item.assertionResults) {
        if (entry.status === "pending" || entry.status === "skipped" || entry.status === "todo") continue;
        tests++; if (entry.status !== "passed" || !finite(entry.duration)) passed = false;
        if (finite(entry.duration)) test_ms += entry.duration;
      }
    }
    return { passed: passed && tests === expected, test_ms, tests };
  } catch { return { passed: false, test_ms: 0, tests: 0 }; }
}

const fixtures = {
  "routine-history": { file: "dashboard/src/server/routine-service.test.ts", pattern: "bounds detail to the latest 20 durable occurrences and keeps older accounting/history intact", tests: 1, prefix: "surtec-routine-service-" },
  "stop-variants": { file: "runner/run-task.test.ts", pattern: "T007 relays independently proven (tokens|runtime|unknown) stop before terminal task ownership is released", tests: 3, prefix: "surtec-runtask-" },
  corrections: { file: "runner/workflow-orchestrator.test.ts", pattern: "consumes once before queueing, uses the prior candidate and requires fresh verification and both reviews QA-request=(false|true)", tests: 2, prefix: "surtec-workflow-worker-" },
  recovery: { file: "runner/workflow-orchestrator.test.ts", pattern: "seals a completed correction after a lost callback and reserves its exact review successor only once across restart", tests: 1, prefix: "surtec-workflow-worker-" },
  "first-planner": { file: "runner/workflow-orchestrator.test.ts", pattern: "runs only the exact first read-only implementation stage and retains a human gate", tests: 1, prefix: "surtec-workflow-worker-" },
} as const;

function prefixInventory(prefix: string): Set<string> { return new Set(fs.readdirSync(resolve(tmpdir())).filter((name) => name.startsWith(prefix))); }
async function runChild(child: ChildProcess, deadline: ProfileDeadline, core: boolean, stopSignal?: AbortSignal): Promise<ChildResult> {
  let output = "", oversized = false, message: unknown;
  child.stdout?.on("data", (chunk: Buffer) => { if (output.length + chunk.length <= OUTPUT_LIMIT) output += chunk.toString(); else oversized = true; });
  // Discard stderr: exception text, paths, record bodies and stacks are not measurements.
  child.stderr?.on("data", () => {}); child.on("message", (value) => { message = value; });
  const result = await superviseChild(child, deadline, 1000, stopSignal);
  return { ...result, failed: result.failed || oversized, output, message, descendants_certain: core && result.closed && !result.expired && !result.failed };
}
function coreReceipt(value: unknown): value is CoreReceipt {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<CoreReceipt>;
  if (!(data.writer_idle === true && typeof data.observation_complete === "boolean" && finite(data.preparation_ms) && finite(data.action_verification_ms) && finite(data.assertion_observation_ms) && data.operations === 100)) return false;
  if (!data.observation_complete) return data.counts === null && data.operation_elapsed_ms === null;
  if (data.counts === null) return data.operation_elapsed_ms === null;
  return operationTable(data.counts, true) && operationTable(data.operation_elapsed_ms, false) && matchingOperationKeys(data.counts, data.operation_elapsed_ms);
}
function matchingOperationKeys(counts: unknown, elapsed: unknown): boolean {
  const countTable = counts as Record<Phase, Counts>, elapsedTable = elapsed as Record<Phase, Counts>;
  return ["preparation", "action_verification", "assertion_observation"].every((phase) => { const key = phase as Phase, names = Object.keys(countTable[key]); return names.length === Object.keys(elapsedTable[key]).length && names.every((name) => countTable[key][name]! > 0 && Object.hasOwn(elapsedTable[key], name)); });
}
/** Measurement acceptance is separate from a receipt's proven writer quiescence. */
export function coreMeasurementPassed(value: unknown, mode: "wall" | "counts"): boolean {
  if (!coreReceipt(value) || !value.observation_complete) return false;
  return mode === "wall" ? value.counts === null && value.operation_elapsed_ms === null : value.counts !== null && value.operation_elapsed_ms !== null;
}
function operationTable(value: unknown, integer: boolean): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const table = value as Record<Phase, Counts>;
  if (Object.keys(table).length !== 3 || Object.keys(table).some((phase) => !["preparation", "action_verification", "assertion_observation"].includes(phase))) return false;
  for (const phase of ["preparation", "action_verification", "assertion_observation"] as const) {
    const counters = table[phase]; if (!counters || typeof counters !== "object" || Array.isArray(counters)) return false;
    const allowed = new Set([...fsNames.map((name) => `fs.${name}`), ...objectNames.map((name) => `object.${name}`)]);
    for (const [key, count] of Object.entries(counters)) if (!allowed.has(key) || !finite(count) || integer && !Number.isSafeInteger(count)) return false;
  }
  return true;
}
const coreSources = ["scripts/profile-maintenance.ts", "lib/state/maintenance.ts", "lib/state/store.ts", "lib/state/events.ts", "lib/state/paths.ts", "lib/state/validation.ts", "schemas/maintenance-control.schema.json"];
function sourceHashes(sources: readonly string[]): Record<string, string> { return Object.fromEntries(sources.map((path) => [path, createHash("sha256").update(fs.readFileSync(join(repository, path))).digest("hex")])); }
export function sourceHashesChanged(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): boolean { return Object.keys(before).length !== Object.keys(after).length || Object.entries(before).some(([key, value]) => after[key] !== value); }

export function profileSummaries(samples: readonly Sample[]): ProfileReport["summaries"] {
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) if (sample.mode === "wall") { const key = `${sample.kind}:${sample.control}`; const group = groups.get(key) ?? []; group.push(sample); groups.set(key, group); }
  return [...groups.values()].map((group) => {
    const passed = group.filter((sample) => sample.status === "passed").map((sample) => sample.wall_ms).sort((left, right) => left - right);
    return { kind: group[0]!.kind, control: group[0]!.control, samples: passed.length, median_wall_ms: passed.length === PROFILE_SAMPLES ? passed[1]! : null, maximum_wall_ms: passed.length === PROFILE_SAMPLES ? passed.at(-1)! : null };
  });
}
export function profileJobs(workload: ProfileWorkload): Array<{ kind: CoreKind | "fixture"; control: ControlKind | null; mode: Sample["mode"]; sample: number }> {
  const jobs: Array<{ kind: CoreKind | "fixture"; control: ControlKind | null; mode: Sample["mode"]; sample: number }> = [];
  if (workload === "core") for (const control of ["absent", "null-hold"] as const) for (const kind of ["boundary", "tasks", "events"] as const) { for (let sample = 1; sample <= PROFILE_SAMPLES; sample++) jobs.push({ kind, control, mode: "wall", sample }); jobs.push({ kind, control, mode: "counts", sample: 1 }); }
  else { for (let sample = 1; sample <= PROFILE_SAMPLES; sample++) jobs.push({ kind: "fixture", control: null, mode: "wall", sample }); if (workload === "first-planner") jobs.push({ kind: "fixture", control: null, mode: "phases", sample: 1 }); }
  return jobs;
}
export function continuePlannerDiagnosis(workload: ProfileWorkload, status: Sample["status"], closed: boolean, expired: boolean, failed: boolean): boolean { return workload === "first-planner" && status === "failed" && closed && !expired && !failed; }

export async function runMaintenanceProfile(workload: ProfileWorkload, deadline = new ProfileDeadline(), progress?: (report: ProfileReport) => void): Promise<ProfileReport> {
  const samples: Sample[] = [], sources = [...coreSources], uninspectedBefore = uninspectedOwnedRootCount();
  if (workload !== "core") sources.push(fixtures[workload].file);
  const source_hashes = sourceHashes(sources);
  const report: ProfileReport = { schema_version: 1, workload, status: "completed", wall_limit_ms: PROFILE_LIMIT_MS, cleanup_reserve_ms: PROFILE_CLEANUP_RESERVE_MS, wall_ms: 0, source_hashes, source_hashes_after: {}, source_drift: null, samples, summaries: [], cleanup: { complete: true, retained_owned_roots: 0, uninspected_owned_roots: 0, fixture_cleanup: workload === "core" ? "not-applicable" : "verified-no-new-prefix-roots" }, limitations: profileLimitations(workload) };
  const jobs = profileJobs(workload);
  for (const job of jobs) {
    if (!deadline.mayLaunch()) { report.status = "deadline"; break; }
    let owned: OwnedRoot | undefined, before: Set<string> | undefined, writersCertain = false;
    const start = performance.now(); let outcome: ChildResult | undefined;
    const sample: Sample = { ...job, status: "failed", wall_ms: 0, preparation_ms: null, action_verification_ms: null, assertion_observation_ms: null, fixture_test_ms: null, operations: 0, counts: null, operation_elapsed_ms: null, planner_phases: null, cleanup_ms: 0, cleanup_complete: false };
    try {
      if (workload === "core") {
        owned = createOwnedProfileRoot();
        fs.writeFileSync(join(owned.path, ".profile-owner"), owned.token, { flag: "wx", mode: 0o600 });
      }
      if (!deadline.mayLaunch()) { sample.status = "deadline"; writersCertain = true; }
      else if (workload === "core" && owned) {
        const child = fork(script, [], { cwd: repository, execArgv: ["--import", "tsx"], env: profileEnvironment(process.env), stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
        const cancellation = new AbortController(), pending = runChild(child, deadline, true, cancellation.signal);
        try { child.send({ kind: job.kind, control: job.control, mode: job.mode, root: owned.path, token: owned.token }); }
        catch { cancellation.abort(); outcome = await pending; throw new Error(); }
        outcome = await pending;
        const receipt = coreReceipt(outcome.message) ? outcome.message : null;
        writersCertain = outcome.descendants_certain && receipt?.writer_idle === true;
        if (outcome.expired) sample.status = "deadline";
        else if (outcome.closed && outcome.exit_code === 0 && !outcome.failed && receipt && job.mode !== "phases") { sample.status = coreMeasurementPassed(receipt, job.mode) ? "passed" : "failed"; sample.operations = receipt.operations; sample.counts = receipt.counts; sample.operation_elapsed_ms = receipt.operation_elapsed_ms; if (job.mode === "wall") { sample.preparation_ms = receipt.preparation_ms; sample.action_verification_ms = receipt.action_verification_ms; sample.assertion_observation_ms = receipt.assertion_observation_ms; } }
      } else if (workload !== "core") {
        const selection = fixtures[workload]; before = prefixInventory(selection.prefix);
        const child = spawn(process.execPath, [join(repository, "node_modules/vitest/vitest.mjs"), "run", selection.file, "--testNamePattern", selection.pattern, "--reporter=json"], { cwd: repository, env: fixtureProfileEnvironment(workload, job.mode, process.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        outcome = await runChild(child, deadline, false);
        const aggregate = summarizeVitestOutput(outcome.output, selection.tests);
        sample.fixture_test_ms = aggregate.test_ms; sample.operations = aggregate.tests;
        if (job.mode === "phases") sample.planner_phases = parsePlannerPhaseOutput(outcome.output);
        // AfterEach contains real worker stop + exact root removal assertions. Do not
        // adopt or remove any discovered test root, and never infer this after abort.
        writersCertain = outcome.closed && !outcome.expired && !outcome.failed && outcome.exit_code === 0 && aggregate.passed;
        if (outcome.expired) sample.status = "deadline";
        else if (writersCertain) { sample.status = job.mode === "phases" && sample.planner_phases?.observation_complete !== true ? "failed" : "passed"; sample.fixture_test_ms = aggregate.test_ms; sample.operations = aggregate.tests; }
        const after = prefixInventory(selection.prefix);
        if (!writersCertain || [...after].some((name) => !before!.has(name))) { writersCertain = false; report.cleanup.fixture_cleanup = "unavailable"; }
      } else {
        throw new Error("Owned core fixture unavailable.");
      }
    } catch { writersCertain = false; }
    sample.wall_ms = performance.now() - start;
    const cleanupStart = performance.now();
    sample.cleanup_complete = workload === "core" ? owned === undefined ? uninspectedOwnedRootCount() === uninspectedBefore : deadline.remaining() > 0 && cleanupOwnedRoot(owned, writersCertain, deadline) : writersCertain;
    sample.cleanup_ms = performance.now() - cleanupStart;
    if (!sample.cleanup_complete) { report.cleanup.complete = false; if (owned) report.cleanup.retained_owned_roots = (report.cleanup.retained_owned_roots ?? 0) + 1; if (workload !== "core") report.cleanup.fixture_cleanup = "unavailable"; }
    samples.push(sample);
    // A progress receipt is explicitly incomplete, even when every finished job passed.
    progress?.({ ...report, status: "failed", samples: [...samples], summaries: profileSummaries(samples), wall_ms: deadline.elapsed(), cleanup: { ...report.cleanup, complete: false, retained_owned_roots: null, uninspected_owned_roots: null, fixture_cleanup: workload === "core" ? "not-applicable" : "unavailable" } });
    if (sample.status !== "passed" || !sample.cleanup_complete) { report.status = sample.status === "deadline" ? "deadline" : "failed"; if (continuePlannerDiagnosis(workload, sample.status, outcome?.closed === true, outcome?.expired !== false, outcome?.failed !== false)) continue; break; }
  }
  report.cleanup.uninspected_owned_roots = uninspectedOwnedRootCount() - uninspectedBefore;
  if (report.cleanup.uninspected_owned_roots > 0) { report.cleanup.complete = false; report.status = "failed"; }
  try { cleanupBudget(deadline); report.source_hashes_after = sourceHashes(sources); cleanupBudget(deadline); report.source_drift = sourceHashesChanged(report.source_hashes, report.source_hashes_after); if (report.source_drift) report.status = "failed"; }
  catch { report.status = deadline.remaining() === 0 ? "deadline" : "failed"; }
  report.summaries = profileSummaries(samples); report.wall_ms = deadline.elapsed();
  if (deadline.remaining() === 0) report.status = "deadline";
  return report;
}

function profileLimitations(workload: ProfileWorkload): string[] { return workload === "core" ? ["Counts and per-export elapsed sums are recorded only in the separate instrumented pass, never the three uninstrumented wall samples.", "Observed export durations are synchronous inclusive timings with observer overhead; nested calls can overlap and must not be summed as a kernel census or disjoint wall-time attribution."] : workload === "first-planner" ? ["Three original wall samples and one separate opt-in timestamp-only phase pass retain the same test, workers and command deadline; a failed wall sample remains failed.", "Vitest durations can include hooks; terminal-observation includes executor, accounting and polling. Phase durations are inclusive observations, not kernel or disjoint attribution.", "A phase receipt is not acceptance; successful real Vitest, all twelve phases, unchanged source hashes and separate cleanup evidence are still required."] : ["Fixture test duration includes its preparation, action and assertions; semantic phase and filesystem attribution are unavailable without editing helpers.", "Fixture cleanup verifies no new known-prefix roots after normal successful test shutdown; interrupted descendant writers remain uncertain."]; }
function safeHashes(value: unknown, workload: ProfileWorkload): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const paths = workload === "core" ? coreSources : [...coreSources, fixtures[workload].file], result: Record<string, string> = {};
  for (const [key, hash] of Object.entries(value)) { if (!paths.includes(key) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return null; result[key] = hash; }
  return result;
}
function safeCounts(value: unknown): Record<Phase, Counts> | null {
  if (!operationTable(value, true)) return null;
  const source = value as Record<Phase, Counts>;
  return { preparation: { ...source.preparation }, action_verification: { ...source.action_verification }, assertion_observation: { ...source.assertion_observation } };
}
function safeOperationElapsed(value: unknown): Record<Phase, Counts> | null {
  if (!operationTable(value, false)) return null;
  const source = value as Record<Phase, Counts>;
  return { preparation: { ...source.preparation }, action_verification: { ...source.action_verification }, assertion_observation: { ...source.assertion_observation } };
}
/** IPC reports are projected onto finite aggregate fields; child text is discarded. */
export function sanitizeProfileReport(value: unknown, workload: ProfileWorkload): ProfileReport | null {
  try {
    if (!value || typeof value !== "object") return null;
    const body = value as ProfileReport;
    if (body.schema_version !== 1 || body.workload !== workload || !["completed", "failed", "deadline"].includes(body.status) || !finite(body.wall_ms) || body.status === "completed" && body.wall_ms > PROFILE_LIMIT_MS) return null;
    const source_hashes = safeHashes(body.source_hashes, workload), source_hashes_after = safeHashes(body.source_hashes_after, workload);
    if (!source_hashes || !source_hashes_after || ![true, false, null].includes(body.source_drift) || !Array.isArray(body.samples) || body.samples.length > 24 || !body.cleanup) return null;
    const samples: Sample[] = [], identities = new Set<string>();
    for (const raw of body.samples) {
      if (!raw || typeof raw !== "object" || !["wall", "counts", "phases"].includes(raw.mode) || !["passed", "failed", "deadline"].includes(raw.status) || !Number.isInteger(raw.sample) || raw.sample < 1 || raw.sample > 3 || typeof raw.cleanup_complete !== "boolean") return null;
      if (workload === "core" ? !["boundary", "tasks", "events"].includes(raw.kind) || !["absent", "null-hold"].includes(raw.control as string) || raw.mode === "phases" : raw.kind !== "fixture" || raw.control !== null || !(raw.mode === "wall" || workload === "first-planner" && raw.mode === "phases")) return null;
      const identity = `${raw.kind}:${raw.control}:${raw.mode}:${raw.sample}`; if (identities.has(identity) || raw.mode !== "wall" && raw.sample !== 1) return null; identities.add(identity);
      for (const number of [raw.wall_ms, raw.cleanup_ms, raw.operations]) if (!finite(number)) return null;
      if (!Number.isInteger(raw.operations) || raw.operations > 100) return null;
      for (const number of [raw.preparation_ms, raw.action_verification_ms, raw.assertion_observation_ms, raw.fixture_test_ms]) if (number !== null && !finite(number)) return null;
      const counts = raw.counts === null ? null : safeCounts(raw.counts); if (raw.counts !== null && !counts) return null;
      const operation_elapsed_ms = raw.operation_elapsed_ms === null ? null : safeOperationElapsed(raw.operation_elapsed_ms); if (raw.operation_elapsed_ms !== null && !operation_elapsed_ms) return null;
      const planner_phases = raw.planner_phases === null ? null : sanitizePlannerPhaseReceipt(raw.planner_phases); if (raw.planner_phases !== null && !planner_phases) return null;
      if (raw.mode !== "phases" && planner_phases !== null || raw.mode === "phases" && (workload !== "first-planner" || counts !== null || operation_elapsed_ms !== null || raw.preparation_ms !== null || raw.action_verification_ms !== null || raw.assertion_observation_ms !== null)) return null;
      if (raw.status === "passed" && raw.mode === "phases" && planner_phases?.observation_complete !== true) return null;
      if (raw.mode === "wall" && operation_elapsed_ms !== null) return null;
      if (raw.status === "passed" && raw.mode === "counts" && (operation_elapsed_ms === null || counts === null || !matchingOperationKeys(counts, operation_elapsed_ms))) return null;
      if (raw.mode === "wall" && counts !== null || raw.mode === "counts" && (raw.preparation_ms !== null || raw.action_verification_ms !== null || raw.assertion_observation_ms !== null)) return null;
      if (raw.status === "passed" && (raw.operations !== (workload === "core" ? 100 : fixtures[workload].tests) || raw.mode === "counts" && counts === null)) return null;
      samples.push({ mode: raw.mode, control: raw.control, kind: raw.kind, sample: raw.sample, status: raw.status, wall_ms: raw.wall_ms, preparation_ms: raw.preparation_ms, action_verification_ms: raw.action_verification_ms, assertion_observation_ms: raw.assertion_observation_ms, fixture_test_ms: raw.fixture_test_ms, operations: raw.operations, counts, operation_elapsed_ms, planner_phases, cleanup_ms: raw.cleanup_ms, cleanup_complete: raw.cleanup_complete });
    }
    const cleanup = body.cleanup;
    if (typeof cleanup.complete !== "boolean" || !["not-applicable", "verified-no-new-prefix-roots", "unavailable"].includes(cleanup.fixture_cleanup)) return null;
    for (const number of [cleanup.retained_owned_roots, cleanup.uninspected_owned_roots]) if (number !== null && (!Number.isInteger(number) || !finite(number))) return null;
    if (body.source_drift !== null && body.source_drift !== sourceHashesChanged(source_hashes, source_hashes_after)) return null;
    if (body.status === "completed" && (samples.length !== (workload === "core" ? 24 : workload === "first-planner" ? 4 : 3) || samples.some((sample) => sample.status !== "passed" || !sample.cleanup_complete) || !cleanup.complete || cleanup.retained_owned_roots !== 0 || cleanup.uninspected_owned_roots !== 0 || body.source_drift !== false || Object.keys(source_hashes).length !== (workload === "core" ? coreSources.length : coreSources.length + 1))) return null;
    return { schema_version: 1, workload, status: body.status, wall_limit_ms: PROFILE_LIMIT_MS, cleanup_reserve_ms: PROFILE_CLEANUP_RESERVE_MS, wall_ms: body.wall_ms, source_hashes, source_hashes_after, source_drift: body.source_drift, samples, summaries: profileSummaries(samples), cleanup: { complete: cleanup.complete, retained_owned_roots: cleanup.retained_owned_roots, uninspected_owned_roots: cleanup.uninspected_owned_roots, fixture_cleanup: cleanup.fixture_cleanup }, limitations: profileLimitations(workload) };
  } catch { return null; }
}

interface ControllerChild extends SupervisedChild {
  on(event: "message", listener: (value: unknown) => void): unknown;
  send(message: { role: "profile-controller"; workload: ProfileWorkload; origin_ms: number }): unknown;
}
function unavailableReport(workload: ProfileWorkload, deadline: ProfileDeadline, expired: boolean, progress: ProfileReport | null = null): ProfileReport {
  const samples = progress?.samples ?? [];
  return { schema_version: 1, workload, status: expired ? "deadline" : "failed", wall_limit_ms: PROFILE_LIMIT_MS, cleanup_reserve_ms: PROFILE_CLEANUP_RESERVE_MS, wall_ms: deadline.elapsed(), source_hashes: progress?.source_hashes ?? {}, source_hashes_after: {}, source_drift: null, samples, summaries: profileSummaries(samples), cleanup: { complete: false, retained_owned_roots: null, uninspected_owned_roots: null, fixture_cleanup: workload === "core" ? "not-applicable" : "unavailable" }, limitations: [...profileLimitations(workload), "Only received completed-job partial measurements are retained; controller completion and active descendant writer cleanup are unavailable. No uncertain fixture was deleted."] };
}
/** The outer watchdog does no campaign FS work, so a blocked controller cannot stall its timer. */
export async function runProfileWatchdog(workload: ProfileWorkload, deadline = new ProfileDeadline(), launch: () => ControllerChild = () => fork(script, [], { cwd: repository, execArgv: ["--import", "tsx"], env: profileEnvironment(process.env), stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true })): Promise<ProfileReport> {
  if (!deadline.mayLaunch()) return unavailableReport(workload, deadline, true);
  let finalReceipt: unknown, progressReceipt: unknown;
  try {
    const controller = launch(), cancellation = new AbortController(), pending = superviseChild(controller, deadline, 1000, cancellation.signal, "cleanup");
    controller.stdout?.on?.("data", () => {}); controller.stderr?.on?.("data", () => {});
    controller.on("message", (value) => { if (value && typeof value === "object") { const data = value as { role?: unknown; report?: unknown }; if (data.role === "profile-report") finalReceipt = data.report; else if (data.role === "profile-progress") progressReceipt = data.report; } });
    try { controller.send({ role: "profile-controller", workload, origin_ms: performance.timeOrigin }); }
    catch { cancellation.abort(); }
    const outcome = await pending;
    const report = sanitizeProfileReport(finalReceipt, workload), partial = sanitizeProfileReport(progressReceipt, workload);
    if (!outcome.closed || outcome.expired || outcome.failed || outcome.exit_code !== 0 || !report) return unavailableReport(workload, deadline, outcome.expired || deadline.remaining() <= 0, partial);
    const result: ProfileReport = report;
    result.wall_ms = deadline.elapsed(); if (deadline.remaining() <= 0) return unavailableReport(workload, deadline, true); return result;
  } catch { return unavailableReport(workload, deadline, deadline.remaining() <= 0); }
}

async function controllerWorker(value: unknown): Promise<void> {
  try {
    if (!value || typeof value !== "object") throw new Error();
    const data = value as { workload?: unknown; origin_ms?: unknown };
    if (!(PROFILE_WORKLOADS as readonly unknown[]).includes(data.workload) || !finite(data.origin_ms)) throw new Error();
    // Epoch origins are immutable, while elapsed time in each process stays monotonic.
    const origin = data.origin_ms, deadline = new ProfileDeadline(() => performance.timeOrigin + performance.now() - origin);
    const report = await runMaintenanceProfile(data.workload as ProfileWorkload, deadline, (partial) => { if (!process.send || !process.connected) throw new Error(); process.send({ role: "profile-progress", report: partial }, () => {}); });
    if (!process.send) throw new Error();
    process.send({ role: "profile-report", report }, (error) => { if (process.connected) process.disconnect(); process.exitCode = error ? 1 : 0; });
  } catch { if (process.connected) process.disconnect(); process.exitCode = 1; }
}

async function coreWorker(message: unknown): Promise<void> {
  let restoreFs: (() => void) | undefined, restoreObject: (() => void) | undefined;
  try {
    if (!message || typeof message !== "object") throw new Error();
    const data = message as Record<string, unknown>;
    if (!["boundary", "tasks", "events"].includes(String(data.kind)) || !["absent", "null-hold"].includes(String(data.control)) || !["wall", "counts"].includes(String(data.mode)) || typeof data.root !== "string" || typeof data.token !== "string") throw new Error();
    const root = resolve(data.root), stat = fs.lstatSync(root);
    if (root !== data.root || dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith(PREFIX) || stat.isSymbolicLink() || !stat.isDirectory() || fs.readFileSync(join(root, ".profile-owner"), "utf8") !== data.token) throw new Error();
    const prepStart = performance.now();
    const counts: Record<Phase, Counts> = { preparation: {}, action_verification: {}, assertion_observation: {} }, operation_elapsed_ms: Record<Phase, Counts> = { preparation: {}, action_verification: {}, assertion_observation: {} }; let phase: Phase = "preparation";
    const monotonic = performance.now.bind(performance);
    if (data.mode === "counts") {
      restoreFs = observeFunctionCalls(fs, fsNames, (name) => { const key = `fs.${name}`; counts[phase][key] = (counts[phase][key] ?? 0) + 1; }, { clock: monotonic, observe: (name, elapsed) => { const key = `fs.${name}`; operation_elapsed_ms[phase][key] = (operation_elapsed_ms[phase][key] ?? 0) + elapsed; } }); syncBuiltinESMExports();
      restoreObject = observeFunctionCalls(Object, objectNames, (name) => { const key = `object.${name}`; counts[phase][key] = (counts[phase][key] ?? 0) + 1; }, { clock: monotonic, observe: (name, elapsed) => { const key = `object.${name}`; operation_elapsed_ms[phase][key] = (operation_elapsed_ms[phase][key] ?? 0) + elapsed; } });
    }
    const maintenance = await import("../lib/state/maintenance"), store = await import("../lib/state/store"), events = await import("../lib/state/events");
    const state = join(root, "state"), tasks = join(state, "tasks"), eventDir = join(state, "events"); fs.mkdirSync(state);
    if (data.control === "null-hold") {
      fs.mkdirSync(join(state, "maintenance")); fs.writeFileSync(join(state, "maintenance/control.json"), JSON.stringify({ schema_version: 1, revision: 1, root_fingerprint: maintenance.maintenanceRootFingerprint(state), created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", hold: null }));
      if (maintenance.readMaintenanceControl(state)?.hold !== null) throw new Error();
    }
    const record: TaskRecord = { envelope: { id: "PROFILE-1", source: "cli", project: "synthetic-profile", task_type: "bugfix", agent: "backend-engineer", title: "Synthetic profile", instructions: "Synthetic diagnostic only", repo_path: join(root, "fictional-repository"), branch: "agent/PROFILE-1", sandbox: "workspace-write", expected_outputs: ["summary"], requires_human_approval: true, metadata: {} }, lifecycle: "queued", outcome: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", started_at: null, finished_at: null, result: null, logs_path: null };
    if (data.kind === "tasks") store.writeTask(record, tasks);
    const preparation_ms = performance.now() - prepStart;
    phase = "action_verification";
    const actionStart = performance.now();
    for (let index = 0; index < 100; index++) {
      if (data.kind === "boundary") maintenance.withMaintenanceMutation(state, () => ({ synthetic: true, index }));
      else if (data.kind === "tasks") store.updateTask("PROFILE-1", (task) => { task.updated_at = "2026-01-01T00:00:01Z"; }, tasks);
      else events.appendTaskEvent({ task_id: "PROFILE-1", type: "warning", revision: index + 1, at: "2026-01-01T00:00:00Z", payload: {} }, eventDir);
    }
    const action_verification_ms = performance.now() - actionStart; phase = "assertion_observation"; const observeStart = performance.now();
    if (data.kind === "tasks" && store.readTask("PROFILE-1", tasks)?.revision !== 100) throw new Error();
    if (data.kind === "events" && events.readTaskEvents("PROFILE-1", eventDir).length !== 100) throw new Error();
    if (fs.existsSync(join(state, "maintenance/boundary.lock"))) throw new Error();
    if (data.control === "absent" && fs.existsSync(join(state, "maintenance/control.json"))) throw new Error();
    const assertion_observation_ms = performance.now() - observeStart;
    const observation_complete = data.mode !== "counts" || Boolean(restoreObject && restoreFs && observationComplete(restoreObject) && observationComplete(restoreFs));
    restoreObject?.(); restoreObject = undefined; restoreFs?.(); restoreFs = undefined; syncBuiltinESMExports();
    const receipt: CoreReceipt = { preparation_ms, action_verification_ms, assertion_observation_ms, operations: 100, counts: data.mode === "counts" && observation_complete ? counts : null, operation_elapsed_ms: data.mode === "counts" && observation_complete ? operation_elapsed_ms : null, observation_complete, writer_idle: true };
    if (!process.send) throw new Error();
    process.send(receipt, (error) => { if (process.connected) process.disconnect(); process.exitCode = error ? 1 : 0; });
  } catch { restoreObject?.(); restoreFs?.(); syncBuiltinESMExports(); if (process.connected) process.disconnect(); process.exitCode = 1; }
}

if (process.send && process.argv[1] && resolve(process.argv[1]) === script) {
  // Internal fork entry accepts exactly one private IPC receipt, never CLI paths.
  process.once("message", (message) => { if (message && typeof message === "object" && (message as { role?: unknown }).role === "profile-controller") void controllerWorker(message); else if (message && typeof message === "object" && (message as { role?: unknown }).role === "planner-fs-controller") void plannerFsControllerWorker(message); else if (message && typeof message === "object" && (message as { role?: unknown }).role === "planner-failure-controller") void plannerFailureControllerWorker(message); else if (message && typeof message === "object" && (message as { role?: unknown }).role === "planner-span-controller") void plannerSpanControllerWorker(message); else if (message && typeof message === "object" && (message as { role?: unknown }).role === "suite-progress-controller") void suiteProgressControllerWorker(message); else if (message && typeof message === "object" && (message as { role?: unknown }).role === "suite-attribution-controller") void suiteAttributionControllerWorker(message); else if (message && typeof message === "object" && (message as { role?: unknown }).role === "suite-workflow-timing-controller") void suiteWorkflowTimingControllerWorker(message); else void coreWorker(message); });
} else if (process.argv[1] && resolve(process.argv[1]) === script) {
  try {
    const workload = parseProfileArguments(process.argv.slice(2));
    const observation = workload === "full-suite-workflow-timing" ? createP12ObservationLossCapture() : null;
    const report = workload === "full-suite-workflow-timing" ? await runSuiteWorkflowTimingDiagnosticWatchdog(undefined, undefined, observation?.handle) : workload === "full-suite-attribution" ? await runSuiteAttributionDiagnosticWatchdog() : workload === "full-suite-progress" ? await runSuiteProgressDiagnosticWatchdog() : workload === "first-planner-spans" ? await runPlannerSpanDiagnosticWatchdog() : workload === "first-planner-failure" ? await runPlannerFailureDiagnosticWatchdog() : workload === "first-planner-fs" ? await runPlannerFsDiagnosticWatchdog() : await runProfileWatchdog(workload);
    const line = `${JSON.stringify(report)}\n`; process.stdout.write(line); process.exitCode = report.status === "completed" ? 0 : 1;
    observation?.emit(report, line);
  } catch { process.stdout.write('{"schema_version":1,"status":"failed","reason":"invalid-selection-or-measurement-unavailable"}\n'); process.exitCode = 1; }
}
