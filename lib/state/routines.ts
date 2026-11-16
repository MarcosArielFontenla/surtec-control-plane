import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, renameSync, unlinkSync, writeFileSync, type Stats,
} from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { isDeepStrictEqual, types as nodeTypes } from "node:util";
import { ROUTINE_LIMITS, type RoutineDocument, type RoutineOccurrence, type RoutineReceipt } from "../routines/types";
import { routineRevisionKey, routineTimestampEpoch } from "../routines/schedule";
import { assertRoutineDocument, assertRoutineReceipt } from "../routines/validation";
import { routineStatePath, locksDir, stateRootForStoreFile } from "./paths";
import { assertMaintenanceAvailable, assertMaintenanceMutation, assertSynchronousMaintenanceResult, withMaintenanceMutation } from "./maintenance";
import { StateLockConflictError } from "./store";

export class RoutineStateError extends Error {
  constructor(message = "Routine state is invalid, unsupported or inaccessible; no automatic repair was performed.") {
    super(message); this.name = "RoutineStateError";
  }
}
export class UnsupportedRoutineVersionError extends RoutineStateError {
  constructor(readonly version: number) { super("Unsupported routine schema version; stored bytes were preserved."); this.name = "UnsupportedRoutineVersionError"; }
}
declare const transactionBrand: unique symbol;
/** An exact live object issued here is required; persisted data and copies are not authority. */
export interface RoutineTransaction { readonly [transactionBrand]: true }
interface TransactionState { working: RoutineDocument; persisted: RoutineDocument | null; path: string; at: string; active: boolean; updating: boolean; checkOwnership: () => void; issued: RoutineOwnership[]; revoked: RoutineOwnership[] }
declare const ownershipBrand: unique symbol;
/** Local store liveness only; not budget, policy, consent or effect authorization. */
export interface RoutineOwnership { readonly [ownershipBrand]: true }
interface OwnershipState { path: string; id: string; claim: RoutineOccurrence; active: boolean }
const ownerships = new WeakMap<object, OwnershipState>();
const transactions = new WeakMap<object, TransactionState>();
let mutationActive = false;
const emptyDocument = (at: string): RoutineDocument => ({ schema_version: 1, revision: 1, created_at: at, updated_at: at, routines: {}, definitions: {}, occurrences: {}, cursors: {} });
function check(ok: boolean, message: string): asserts ok { if (!ok) throw new RoutineStateError(message); }
function clone<T>(value: T): T { return structuredClone(value); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function safePath(path: string, file: boolean): void {
  const absolute = resolve(path), root = parse(absolute).root, segments = absolute.slice(root.length).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index]!); let stat: Stats;
    try { stat = lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new RoutineStateError(); }
    const lastFile = file && index === segments.length - 1;
    check(!stat.isSymbolicLink() && (lastFile ? stat.isFile() && stat.nlink === 1 : stat.isDirectory()), "Unsafe routine storage path; no automatic repair was performed.");
  }
}
/** Bound every read, including lock tokens, and verify the opened and named file. */
function readBytes(path: string, maximum: number): Buffer | null {
  safePath(path, true); let before: Stats;
  try { before = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new RoutineStateError(); }
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maximum, "Unsafe or oversized routine storage file.");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const opened = fstatSync(fd);
    check(opened.isFile() && opened.nlink === 1 && sameFile(before, opened) && opened.size === before.size, "Routine storage changed while opening.");
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (count === 0) break; length += count; }
    const after = fstatSync(fd), named = lstatSync(path);
    check(length === before.size && after.size === before.size && after.nlink === 1 && named.nlink === 1 && sameFile(before, after) && sameFile(before, named)
      && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && !named.isSymbolicLink(), "Routine storage changed while reading.");
    safePath(path, true); return buffer.subarray(0, length);
  } catch (error) { if (error instanceof RoutineStateError) throw error; throw new RoutineStateError(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function read(path: string): RoutineDocument | null {
  const bytes = readBytes(path, ROUTINE_LIMITS.documentBytes); if (bytes === null) return null;
  return decode(bytes);
}
function decode(bytes: Buffer): RoutineDocument {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const version = value !== null && typeof value === "object" ? (value as { schema_version?: unknown }).schema_version : undefined;
    if (typeof version === "number" && version > 1) throw new UnsupportedRoutineVersionError(version);
    assertRoutineDocument(value); return value;
  } catch (error) { if (error instanceof UnsupportedRoutineVersionError) throw error; throw new RoutineStateError(); }
}
function ownedCleanup(path: string, stat: Stats): void {
  try { safePath(path, true); const current = lstatSync(path); if (current.isFile() && current.nlink === 1 && sameFile(current, stat)) unlinkSync(path); }
  catch { /* Unknown/replaced paths are deliberately preserved. */ }
}
function atomicWrite(path: string, document: RoutineDocument, checkOwnership: () => void): void {
  const encoded = encode(document); check(Buffer.byteLength(encoded) <= ROUTINE_LIMITS.documentBytes, "Routine snapshot exceeds byte limit.");
  const staged = `${path}.${randomUUID()}.tmp`; let fd: number | undefined, stat: Stats | undefined, created = false;
  try {
    checkOwnership();
    safePath(path, true); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); safePath(path, true);
    checkOwnership();
    fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); created = true; stat = fstatSync(fd);
    writeFileSync(fd, encoded, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
    safePath(path, true); safePath(staged, true); check(sameFile(stat, lstatSync(staged)), "Routine staged ownership was lost."); checkOwnership();
    renameSync(staged, path); created = false;
  } catch { throw new RoutineStateError("Routine replacement failed; inspect the preserved snapshot before retrying."); }
  finally { if (fd !== undefined) closeSync(fd); if (created && stat !== undefined) ownedCleanup(staged, stat); }
}
function withRoutineLock<T>(directory: string, action: (checkOwnership: () => void) => T): T {
  try { safePath(directory, false); mkdirSync(directory, { recursive: true, mode: 0o700 }); safePath(directory, false); }
  catch { throw new RoutineStateError(); }
  const path = join(directory, "routines.lock"), token = `${process.pid}\n${randomUUID()}\n`; safePath(path, true);
  let fd: number;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new StateLockConflictError("Routine state lock is busy; explicit inspected recovery is required.");
    throw new RoutineStateError();
  }
  let stat: Stats;
  try { stat = fstatSync(fd); }
  catch { try { closeSync(fd); } catch { /* Ownership is unknown; preserve the named lock. */ } throw new RoutineStateError("Routine lock identity could not be inspected; explicit recovery is required."); }
  const checkOwnership = () => {
    try { safePath(directory, false); const current = lstatSync(path); check(sameFile(stat, current), "Routine lock ownership was lost."); const bytes = readBytes(path, Buffer.byteLength(token)); check(bytes !== null && bytes.toString("utf8") === token, "Routine lock ownership was lost."); }
    catch { throw new RoutineStateError("Routine lock ownership was lost; explicit inspected recovery is required."); }
  };
  let initialized = false;
  try {
    try { writeFileSync(fd, token, "utf8"); fsyncSync(fd); initialized = true; }
    catch { throw new RoutineStateError("Routine lock initialization failed; no snapshot was replaced."); }
    checkOwnership(); return action(checkOwnership);
  } finally {
    closeSync(fd);
    if (initialized) { checkOwnership(); try { unlinkSync(path); } catch { throw new RoutineStateError("Routine lock release failed; inspect ownership and the current snapshot before retrying."); } }
    else ownedCleanup(path, stat);
  }
}
function callbackValid(callback: unknown): asserts callback is (...args: never[]) => unknown {
  check(typeof callback === "function" && !nodeTypes.isProxy(callback) && !nodeTypes.isAsyncFunction(callback) && !nodeTypes.isGeneratorFunction(callback), "Routine mutation must be synchronous and non-proxied.");
}
function synchronous(value: unknown): void {
  try { assertSynchronousMaintenanceResult(value); }
  catch { throw new RoutineStateError("Routine mutation must be synchronous; uncertain maintenance ownership was preserved."); }
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  const seen = new Set<object>(); let current: object | null = value;
  while (current !== null) {
    check(!nodeTypes.isProxy(current) && !nodeTypes.isPromise(current) && !seen.has(current), "Routine mutation must be synchronous and non-proxied."); seen.add(current);
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (current !== Object.prototype && current !== Function.prototype) check(Reflect.ownKeys(descriptors).every((key) => Object.hasOwn(descriptors[key as keyof typeof descriptors]!, "value")), "Routine mutation result cannot contain accessors.");
    check(!Object.hasOwn(descriptors, "then"), "Routine mutation must be synchronous."); current = Object.getPrototypeOf(current) as object | null;
  }
}
function live(tx: unknown): TransactionState {
  check(tx !== null && typeof tx === "object" && !nodeTypes.isProxy(tx), "Routine transaction proof is invalid or stale.");
  const state = transactions.get(tx); check(!!state && state.active && !state.updating, "Routine transaction proof is invalid, reentrant or stale."); state.checkOwnership(); return state;
}

/** Encode only already validated inert data, never inherited serialization hooks. */
function encode(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(encode).join(",") + "]";
  return "{" + Object.keys(value).map((key) => JSON.stringify(key) + ":" + encode((value as Record<string, unknown>)[key])).join(",") + "}";
}
function time(created: string, updated: string, at: string, previous?: string): void {
  check(updated === at && routineTimestampEpoch(created) <= routineTimestampEpoch(at)
    && (previous === undefined || routineTimestampEpoch(previous) <= routineTimestampEpoch(at)), "Routine child timestamp must use the ordered transaction time.");
}
function immutable(before: unknown, after: unknown): void { check(isDeepStrictEqual(before, after), "Routine historical bindings are immutable."); }
function advanced(before: number, after: number): void {
  check(before < Number.MAX_SAFE_INTEGER && after === before + 1, "Routine revision must advance exactly once.");
}
function identifier(value: unknown): asserts value is string {
  check(typeof value === "string" && !value.includes("..") && !["constructor", "prototype", "__proto__"].includes(value)
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$(?![\s\S])/.test(value), "Invalid routine ownership identifier.");
}
function currentDefinition(document: RoutineDocument, occurrence: RoutineOccurrence): boolean {
  const current = document.routines[occurrence.routine_id];
  return !!current && current.enabled && isDeepStrictEqual(current, occurrence.definition);
}
function isTerminal(occurrence: RoutineOccurrence): boolean { return !["reserved", "running"].includes(occurrence.status); }
function uncertainRecovery(occurrence: RoutineOccurrence): boolean {
  const receipt = occurrence.receipt;
  return occurrence.status === "needs-review" && occurrence.finished_at === null && receipt !== null
    && receipt.freshness === "unavailable" && receipt.budget_outcome === "unknown"
    && receipt.consumption.runtime_state === "unknown" && receipt.consumption.attempts === 1 && receipt.consumption.runtime_ms === null
    && receipt.failure_code === "ownership-unavailable" && receipt.next_action === "resolve-ownership"
    && receipt.sources.length === 0 && receipt.proposals.length === 0
    && receipt.counts.signals_evaluated === 0 && receipt.counts.proposals_created === 0 && receipt.counts.reports_written === 0;
}
type Operation = { kind: "claim" | "finish"; id: string } | undefined;
function transition(state: TransactionState, after: RoutineDocument, operation?: Operation): void {
  const before = state.working, at = state.at;
  immutable([before.schema_version, before.revision, before.created_at], [after.schema_version, after.revision, after.created_at]);
  for (const name of ["routines", "definitions", "occurrences", "cursors"] as const) {
    check(Object.keys(before[name]).every((id) => Object.hasOwn(after[name], id)), "Routine maps are append-only.");
  }
  for (const [key, definition] of Object.entries(before.definitions)) immutable(definition, after.definitions[key]);
  for (const [id, current] of Object.entries(after.routines)) {
    const previous = before.routines[id];
    if (!previous) {
      check(current.revision === 1 && !current.enabled && current.created_at === at, "New routine must be a disabled first revision.");
      time(current.created_at, current.updated_at, at);
    } else if (!isDeepStrictEqual(previous, current)) {
      immutable([previous.id, previous.schema_version, previous.created_at], [current.id, current.schema_version, current.created_at]);
      advanced(previous.revision, current.revision); time(current.created_at, current.updated_at, at, previous.updated_at);
    }
  }
  for (const [key, current] of Object.entries(after.definitions)) {
    if (!Object.hasOwn(before.definitions, key)) {
      check(current.updated_at === at && isDeepStrictEqual(current, after.routines[current.id]), "New definition must be the exact current revision at transaction time.");
    }
  }
  const added = Object.values(after.occurrences).filter((entry) => !Object.hasOwn(before.occurrences, entry.id));
  check(added.length <= 1, "Routine update cannot admit multiple occurrences.");
  for (const [id, current] of Object.entries(after.occurrences)) {
    const previous = before.occurrences[id];
    if (!previous) {
      check(current.revision === 1 && current.created_at === at && current.owner === null && current.started_at === null
        && (current.status === "reserved" && current.cancel_requested_at === null
          || isTerminal(current) && current.receipt?.consumption.attempts === 0), "New occurrence must retain only unstarted facts.");
      check(isDeepStrictEqual(after.routines[current.routine_id], current.definition), "New occurrence requires its exact current configuration.");
      check(!Object.values(before.occurrences).some((entry) => !isTerminal(entry) || entry.status === "needs-review" && entry.routine_id === current.routine_id),
        "Unresolved occurrence ownership blocks new admission.");
      if (current.trigger === "manual") check(routineTimestampEpoch(current.slot) === routineTimestampEpoch(at), "Manual occurrence must use its exact admission slot.");
      else {
        const cursor = state.persisted?.cursors[routineRevisionKey(current.routine_id, current.routine_revision)];
        check(!cursor?.last_slot || routineTimestampEpoch(current.slot) > routineTimestampEpoch(cursor.last_slot)
          || cursor.pending_slot !== null && routineTimestampEpoch(current.slot) === routineTimestampEpoch(cursor.pending_slot)
            && current.trigger === "coalesced", "Considered routine slots cannot replay.");
      }
      time(current.created_at, current.updated_at, at); continue;
    }
    if (isDeepStrictEqual(previous, current)) continue;
    check(!isTerminal(previous), "Terminal occurrence history is immutable and cannot reopen.");
    const fields = ["schema_version", "id", "routine_id", "routine_revision", "occurrence_key", "definition", "slot", "trigger",
      "project_ids", "attribution", "budget", "created_at"] as const;
    for (const field of fields) immutable(previous[field], current[field]);
    advanced(previous.revision, current.revision); time(current.created_at, current.updated_at, at, previous.updated_at);
    check(previous.cancel_requested_at === null ? current.cancel_requested_at === null || current.cancel_requested_at === at
      : previous.cancel_requested_at === current.cancel_requested_at, "Routine cancellation intent is append-only.");
    if (previous.status === "reserved" && current.status === "running") {
      check(operation?.kind === "claim" && operation.id === id && previous.cancel_requested_at === null,
        "Routine claim requires exact private ownership admission.");
    } else {
      immutable([previous.owner, previous.started_at], [current.owner, current.started_at]);
      if (previous.status === "running" && isTerminal(current)) {
        check(operation?.kind === "finish" && operation.id === id || uncertainRecovery(current),
          "Routine completion requires private ownership or conservative unknown recovery.");
      } else if (previous.status === "reserved" && isTerminal(current)) {
        check(current.receipt?.consumption.attempts === 0, "Unstarted occurrence cannot invent execution.");
      } else {
        immutable([previous.status, previous.finished_at, previous.receipt], [current.status, current.finished_at, current.receipt]);
      }
    }
  }
  for (const [key, current] of Object.entries(after.cursors)) {
    const previous = before.cursors[key];
    if (previous) {
      immutable([previous.schema_version, previous.routine_id, previous.routine_revision], [current.schema_version, current.routine_id, current.routine_revision]);
      check(routineTimestampEpoch(current.evaluated_at) >= routineTimestampEpoch(previous.evaluated_at)
        && (previous.last_slot === null || current.last_slot !== null
          && routineTimestampEpoch(current.last_slot) >= routineTimestampEpoch(previous.last_slot)), "Routine cursor high-water cannot decrease.");
      check(previous.pending_slot !== null || current.pending_slot === null || previous.last_slot === null
        || routineTimestampEpoch(current.pending_slot) > routineTimestampEpoch(previous.last_slot), "Consumed pending slot cannot be resurrected.");
    }
    if (!isDeepStrictEqual(previous, current)) check(current.evaluated_at === at, "Changed routine cursor must use transaction time.");
  }
}
function update(state: TransactionState, callback: (document: RoutineDocument, at: string) => void, operation?: Operation): void {
  callbackValid(callback); const draft = clone(state.working); state.updating = true;
  try {
    const result = callback(draft, state.at); synchronous(result);
    // Metadata is store-owned. Check descriptors without invoking injected hooks.
    for (const key of ["schema_version", "revision", "created_at", "updated_at"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(draft, key);
      check(!!descriptor && Object.hasOwn(descriptor, "value") && descriptor.value === state.working[key],
        "Routine aggregate metadata is store-owned.");
    }
    Object.defineProperty(draft, "updated_at", { value: state.at });
    assertRoutineDocument(draft); transition(state, draft, operation); state.checkOwnership();
    const content = clone(draft); content.updated_at = state.working.updated_at;
    if (!isDeepStrictEqual(content, state.working)) state.working = clone(draft);
  } finally { state.updating = false; }
}
function privateOwnership(proof: unknown, path: string): OwnershipState {
  check(proof !== null && typeof proof === "object" && !nodeTypes.isProxy(proof), "Routine ownership proof is invalid or stale.");
  const owner = ownerships.get(proof);
  check(!!owner && owner.active && owner.path === path, "Routine ownership proof is invalid, revoked or stale.");
  return owner;
}
function boundOccurrence(owner: OwnershipState, document: RoutineDocument | null): RoutineOccurrence {
  const entry = document?.occurrences[owner.id];
  check(!!entry && entry.status === "running" && entry.revision >= owner.claim.revision,
    "Routine live ownership differs from its exact persisted claim.");
  for (const key of ["schema_version", "id", "routine_id", "routine_revision", "occurrence_key", "definition", "slot", "trigger",
    "project_ids", "attribution", "budget", "owner", "started_at", "created_at"] as const) {
    check(isDeepStrictEqual(entry[key], owner.claim[key]), "Routine live ownership differs from its exact persisted claim.");
  }
  return entry;
}
/** Optional absence has no filesystem, lock, clock or invented-history effects. */
export function readRoutineDocument(filePath: string = routineStatePath()): RoutineDocument | null {
  const document = read(resolve(filePath)); return document === null ? null : freeze(document);
}
export function readRoutineTransaction(tx: unknown): { document: RoutineDocument; at: string } {
  const state = live(tx); return freeze({ document: clone(state.working), at: state.at });
}
export function updateRoutineTransaction(tx: unknown, callback: (document: RoutineDocument, at: string) => void): void {
  update(live(tx), callback);
}
/** Only local claim liveness. The future dispatcher must independently enforce every budget/policy/consent gate. */
export function claimRoutineOccurrence(tx: unknown, id: string, expectedRevision: number, workerId: string): RoutineOwnership {
  const state = live(tx); identifier(id); identifier(workerId);
  const occurrence = state.working.occurrences[id], durable = state.persisted?.occurrences[id];
  check(!!occurrence && !!durable && durable.status === "reserved" && occurrence.status === "reserved"
    && occurrence.revision === expectedRevision && occurrence.cancel_requested_at === null && currentDefinition(state.working, occurrence),
    "Routine claim requires its exact durable enabled unstarted occurrence.");
  check(!Object.values(state.working.occurrences).some((entry) => entry.id !== id
    && (!isTerminal(entry) || entry.status === "needs-review" && entry.routine_id === occurrence.routine_id)), "Routine ownership is busy or unresolved.");
  const inventory = { run_id: randomUUID(), worker_id: workerId, claimed_at: state.at };
  update(state, (draft) => {
    const entry = draft.occurrences[id]!; entry.status = "running"; entry.owner = inventory; entry.started_at = state.at;
    entry.revision++; entry.updated_at = state.at;
  }, { kind: "claim", id });
  const proof = Object.freeze({}) as RoutineOwnership;
  ownerships.set(proof, { path: state.path, id, claim: clone(state.working.occurrences[id]!), active: false });
  state.issued.push(proof); return proof;
}
/** Read-only liveness fence, not permission to perform an action. No persisted owner is adopted. */
export function assertRoutineOwnership(proof: unknown, filePath: string = routineStatePath()): Readonly<RoutineOccurrence> {
  check(!mutationActive, "Routine ownership cannot be checked inside a state transaction.");
  const owner = privateOwnership(proof, resolve(filePath));
  assertMaintenanceAvailable(stateRootForStoreFile(owner.path, "routines"));
  const document = read(owner.path), occurrence = boundOccurrence(owner, document);
  check(occurrence.cancel_requested_at === null && currentDefinition(document!, occurrence), "Routine execution was cancelled or its configuration changed.");
  return freeze(clone(occurrence));
}
export function revokeRoutineOwnership(proof: unknown): void {
  check(!mutationActive, "Routine ownership cannot be revoked inside a state transaction.");
  check(proof !== null && typeof proof === "object" && !nodeTypes.isProxy(proof), "Routine ownership proof is invalid or stale.");
  const owner = ownerships.get(proof); check(!!owner, "Routine ownership proof is invalid or stale."); owner.active = false;
}
export function finishRoutineOccurrence(tx: unknown, proof: unknown, expectedRevision: number, receipt: RoutineReceipt,
  status: Exclude<RoutineOccurrence["status"], "reserved" | "running">): void {
  const state = live(tx), owner = privateOwnership(proof, state.path), entry = boundOccurrence(owner, state.working);
  check(entry.revision === expectedRevision && isDeepStrictEqual(entry, state.persisted?.occurrences[entry.id]),
    "Routine completion requires its exact durable revision.");
  assertRoutineReceipt(receipt);
  check(receipt.consumption.attempts === 1, "Routine completion must retain its known claimed attempt.");
  if (status === "completed") {
    check(entry.cancel_requested_at === null || receipt.finished_at !== null
      && routineTimestampEpoch(receipt.finished_at) <= routineTimestampEpoch(entry.cancel_requested_at),
    "Routine completion cannot hide a prior durable cancellation.");
    const firstChange = state.working.definitions[routineRevisionKey(entry.routine_id, entry.routine_revision + 1)];
    check(currentDefinition(state.working, entry) || receipt.finished_at !== null
      && !!firstChange && routineTimestampEpoch(receipt.finished_at) <= routineTimestampEpoch(firstChange.updated_at),
    "Routine completion cannot hide a prior configuration change.");
  }
  update(state, (draft) => {
    const current = draft.occurrences[entry.id]!; current.status = status; current.receipt = clone(receipt); current.finished_at = receipt.finished_at;
    current.revision++; current.updated_at = state.at;
  }, { kind: "finish", id: entry.id });
  state.revoked.push(proof as RoutineOwnership);
}
/** Synchronous state-only critical section; no awaits, effects, or nested store locks. */
export function mutateRoutineDocument<T>(callback: (tx: RoutineTransaction) => T, filePath: string = routineStatePath(),
  at: string = new Date().toISOString()): T {
  callbackValid(callback); check(!mutationActive, "Routine mutation is reentrant."); routineTimestampEpoch(at);
  const path = resolve(filePath), root = stateRootForStoreFile(path, "routines");
  read(path); // A discarded preflight refuses invalid/future/unsafe bytes before directory creation.
  assertMaintenanceAvailable(root);
  let committedState: TransactionState | undefined, success = false;
  try {
    const result = withMaintenanceMutation(root, () => {
      mutationActive = true;
      try {
        return withRoutineLock(locksDir(root), (checkLock) => {
          assertMaintenanceMutation(root);
          const originalBytes = readBytes(path, ROUTINE_LIMITS.documentBytes);
          const persisted = originalBytes === null ? null : decode(originalBytes), before = persisted ?? emptyDocument(at);
          assertRoutineDocument(before); check(routineTimestampEpoch(before.updated_at) <= routineTimestampEpoch(at), "Routine transaction clock cannot regress.");
          const checkOwnership = () => {
            assertMaintenanceMutation(root);
            checkLock(); const current = readBytes(path, ROUTINE_LIMITS.documentBytes);
            check(originalBytes === null ? current === null : current !== null && originalBytes.equals(current), "Routine snapshot changed outside its owned transaction.");
          };
          checkOwnership();
          const tx = Object.freeze({}) as RoutineTransaction;
          const state: TransactionState = { working: clone(before), persisted, path, at, active: true, updating: false, checkOwnership, issued: [], revoked: [] };
          committedState = state; transactions.set(tx, state);
          try {
            const result = callback(tx); synchronous(result); checkOwnership();
            if (!isDeepStrictEqual(before, state.working)) {
              check(persisted === null || before.revision < Number.MAX_SAFE_INTEGER, "Routine document revision is exhausted.");
              const final = clone(state.working); final.revision = persisted === null ? 1 : before.revision + 1; final.updated_at = at;
              assertRoutineDocument(final); atomicWrite(path, final, checkOwnership);
            }
            return result;
          } finally { state.active = false; transactions.delete(tx); }
        });
      } finally { mutationActive = false; }
    });
    success = true; return result;
  } finally {
    if (committedState) {
      for (const proof of committedState.issued) {
        const owner = ownerships.get(proof)!;
        owner.active = success && committedState.working.occurrences[owner.id]?.status === "running";
      }
      if (success) for (const proof of committedState.revoked) ownerships.get(proof)!.active = false;
    }
  }
}
