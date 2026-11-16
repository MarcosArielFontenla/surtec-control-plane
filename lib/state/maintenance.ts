import Ajv2020 from "ajv/dist/2020.js";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import { types as nodeTypes } from "node:util";
import schema from "../../schemas/maintenance-control.schema.json";
import { maintenanceControlPath, maintenanceDir, maintenanceGatePath, maintenanceOwnersDir, stateDir } from "./paths";

// Keep the established constructor identity for existing contention callers.
export class StateLockConflictError extends Error {}
export { StateLockConflictError as MaintenanceConflictError };
export class MaintenanceStateError extends Error {
  constructor(message = "Maintenance state or ownership is unavailable; no automatic recovery was performed.") { super(message); this.name = "MaintenanceStateError"; }
}
export class UnsupportedMaintenanceVersionError extends MaintenanceStateError {
  constructor(readonly version: number) { super("Unsupported maintenance version; original bytes were preserved."); this.name = "UnsupportedMaintenanceVersionError"; }
}
export interface MaintenanceControl {
  schema_version: 1; revision: number; root_fingerprint: string; created_at: string; updated_at: string;
  hold: { id: string; operation_id: string; kind: "restore" | "rollback" | "ownership-review"; created_at: string } | null;
}
type OwnerKind = "mutation" | "exclusive" | "coordination" | "api" | "worker" | "task" | "routine" | "project-command" | "operation";
interface OwnerRecord { schema_version: 1; id: string; root_fingerprint: string; pid: number; kind: OwnerKind; created_at: string }
interface Lease { root: string; path: string; fd: number; stat: Stats; rootStat: Stats; bytes: Buffer; active: boolean; kind: OwnerKind; uncertain?: boolean }
declare const exclusiveBrand: unique symbol, participantBrand: unique symbol;
export interface MaintenanceExclusive { readonly [exclusiveBrand]: true }
export interface MaintenanceParticipant { readonly [participantBrand]: true }
const frames = new Map<string, Lease>(), exclusives = new WeakMap<object, Lease>(), participants = new WeakMap<object, Lease>();
const MAX_BYTES = 16 * 1024 * 1024, MAX_OWNERS = 10000;
const ajv = new Ajv2020({ strict: true, allErrors: false, ownProperties: true, coerceTypes: false });
ajv.addFormat("date-time", { type: "string", validate: utc }); ajv.addSchema(schema);
const validateControl = ajv.getSchema(schema.$id)!, validateOwner = ajv.getSchema(`${schema.$id}#/$defs/owner`)!;
function ensure(condition: unknown, message?: string): asserts condition { if (!condition) throw new MaintenanceStateError(message); }
function utc(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$(?![\s\S])/.test(value)) return false;
  const epoch = Date.parse(value); return Number.isSafeInteger(epoch) && Number(value.slice(0, 4)) > 0 && new Date(epoch).toISOString().slice(0, 19) === value.slice(0, 19);
}
function identity(root: string): string { return process.platform === "win32" ? root.toLowerCase() : root; }
function fingerprint(root: string): string { return createHash("sha256").update(identity(root)).digest("hex"); }
function canonical(root: string): string { ensure(typeof root === "string" && root.length > 0); const absolute = resolve(root); ensure(absolute !== parse(absolute).root, "A drive root is not a maintenance boundary."); safePath(absolute, false); return absolute; }
export function maintenanceRootFingerprint(root: string): string { return fingerprint(canonical(root)); }
function same(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function safePath(path: string, file: boolean): Stats | undefined {
  const absolute = resolve(path), prefix = parse(absolute).root; let current = prefix;
  const parts = absolute.slice(prefix.length).split(/[\\/]/).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    // resolve() already normalized each segment; do not normalize the growing
    // ancestor path again for every fresh filesystem sample.
    current = index === 0 ? `${prefix}${parts[index]!}` : `${current}${sep}${parts[index]!}`;
    let stat: Stats | undefined;
    // Missing optional metadata is not an exception or a cached availability fact.
    try { stat = lstatSync(current, { throwIfNoEntry: false }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new MaintenanceStateError(); }
    if (stat === undefined) return;
    ensure(!stat.isSymbolicLink() && (file && index === parts.length - 1 ? stat.isFile() && stat.nlink === 1 : stat.isDirectory()), "Unsafe maintenance boundary; bytes were preserved.");
    if (index === parts.length - 1) return stat;
  }
}
function bytes(path: string, maximum = MAX_BYTES): Buffer | null {
  // Reuse only the terminal stat from this fresh complete prefix walk.
  // Never reuse filesystem facts across guards or drop the late lease checks.
  const stat = safePath(path, true); if (stat === undefined) return null;
  ensure(stat.size <= maximum); let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const opened = fstatSync(fd);
    ensure(opened.isFile() && opened.nlink === 1 && same(stat, opened) && stat.size === opened.size);
    const result = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < result.length) { const count = readSync(fd, result, length, result.length - length, null); if (count === 0) break; length += count; }
    const after = fstatSync(fd), named = safePath(path, true);
    ensure(named !== undefined && length === stat.size && after.size === stat.size && named.size === stat.size && after.nlink === 1
      && same(stat, after) && same(stat, named) && stat.mtimeMs === after.mtimeMs && stat.ctimeMs === after.ctimeMs
      && stat.mtimeMs === named.mtimeMs && stat.ctimeMs === named.ctimeMs);
    return result.subarray(0, length);
  } catch (error) { if (error instanceof MaintenanceStateError) throw error; throw new MaintenanceStateError(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
// Serialization never invokes inherited toJSON/getter hooks on control data.
function encode(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) { const parts: string[] = []; for (let i = 0; i < value.length; i++) parts.push(encode(value[i])); return `[${parts.join(",")}]`; }
  const descriptors = Object.getOwnPropertyDescriptors(value), parts: string[] = [];
  for (const key of Object.keys(descriptors)) { const property = descriptors[key]!; ensure(Object.hasOwn(property, "value") && property.enumerable); parts.push(`${JSON.stringify(key)}:${encode(property.value)}`); }
  return `{${parts.join(",")}}`;
}
export function readMaintenanceControl(root: string = stateDir()): MaintenanceControl | null {
  return readControl(canonical(root));
}
function readControl(absolute: string): MaintenanceControl | null {
  return decodeControl(bytes(maintenanceControlPath(absolute)), absolute);
}
function decodeControl(data: Buffer | null, absolute: string): MaintenanceControl | null {
  if (data === null) return null;
  try {
    const record: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    const version = record && typeof record === "object" ? (record as { schema_version?: unknown }).schema_version : undefined;
    if (typeof version === "number" && version > 1) throw new UnsupportedMaintenanceVersionError(version);
    ensure(validateControl(record)); const control = record as MaintenanceControl;
    ensure(control.root_fingerprint === fingerprint(absolute) && Date.parse(control.created_at) <= Date.parse(control.updated_at)
      && (control.hold === null || Date.parse(control.created_at) <= Date.parse(control.hold.created_at) && Date.parse(control.hold.created_at) <= Date.parse(control.updated_at)));
    return Object.freeze({ ...control, hold: control.hold === null ? null : Object.freeze({ ...control.hold }) });
  } catch (error) { if (error instanceof MaintenanceStateError) throw error; throw new MaintenanceStateError(); }
}
function noHold(root: string): void { ensure(readControl(root)?.hold == null, "Maintenance hold blocks operating mutations; explicit inspected recovery is required."); }
function ownerRecord(root: string, kind: OwnerKind): OwnerRecord { return { schema_version: 1, id: randomUUID(), root_fingerprint: fingerprint(root), pid: process.pid, kind, created_at: new Date().toISOString() }; }
function checkLease(lease: Lease): void {
  try {
    ensure(lease.active, "Maintenance ownership is stale or not privately issued."); const current = bytes(lease.path, 2048);
    ensure(same(lease.rootStat, lstatSync(lease.root)));
    ensure(current !== null && current.equals(lease.bytes) && same(lease.stat, lstatSync(lease.path)), "Maintenance ownership changed; unknown files were preserved.");
  } catch (error) { if (error instanceof MaintenanceStateError) throw error; throw new MaintenanceStateError(); }
}
function ownedRemoval(lease: Lease): void { checkLease(lease); closeSync(lease.fd); lease.active = false; unlinkSync(lease.path); }
function openOwner(root: string, path: string, kind: OwnerKind, record = ownerRecord(root, kind)): Lease {
  safePath(path, true); const encoded = Buffer.from(encode(record)); let fd: number;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new StateLockConflictError("Maintenance ownership is busy or unknown; no age-based recovery is permitted."); throw new MaintenanceStateError(); }
  let lease: Lease | undefined;
  try {
    lease = { root, path, fd, stat: fstatSync(fd), rootStat: lstatSync(root), bytes: encoded, active: true, kind };
    writeFileSync(fd, encoded); fsyncSync(fd); checkLease(lease); return lease;
  } catch { closeSync(fd); if (lease) lease.active = false; throw new MaintenanceStateError("Maintenance initialization failed; retained ownership requires inspection."); }
}
function gate(root: string, kind: "mutation" | "exclusive" | "coordination", allowHold = false): Lease {
  const absolute = canonical(root); if (!allowHold) noHold(absolute); else readMaintenanceControl(absolute);
  safePath(maintenanceDir(absolute), false); mkdirSync(maintenanceDir(absolute), { recursive: true, mode: 0o700 }); safePath(maintenanceDir(absolute), false);
  const lease = openOwner(absolute, maintenanceGatePath(absolute), kind);
  try { if (!allowHold) noHold(absolute); else readMaintenanceControl(absolute); return lease; }
  catch (error) {
    try { ownedRemoval(lease); } finally { if (lease.active) { closeSync(lease.fd); lease.active = false; } }
    throw error;
  }
}
function callback(action: unknown): asserts action is () => unknown {
  ensure(typeof action === "function" && !nodeTypes.isProxy(action) && !nodeTypes.isAsyncFunction(action) && !nodeTypes.isGeneratorFunction(action), "Maintenance mutation must be synchronous and non-proxied.");
}
/** Unknown asynchronous work cannot be cancelled by a synchronous lock release. */
export function assertSynchronousMaintenanceResult(result: unknown): void {
  try {
    if (result === null || typeof result !== "object" && typeof result !== "function") return;
    const seen = new Set<object>(); let current = result as object | null;
    while (current !== null) {
      ensure(!nodeTypes.isProxy(current) && !nodeTypes.isPromise(current) && !nodeTypes.isGeneratorObject(current) && !seen.has(current)); seen.add(current);
      const descriptors = Object.getOwnPropertyDescriptors(current); ensure(!Object.hasOwn(descriptors, "then"), "Maintenance mutation cannot return a thenable."); current = Object.getPrototypeOf(current);
    }
  } catch {
    // Keep named gates as unknown evidence; never adopt or age-steal them later.
    for (const lease of frames.values()) lease.uncertain = true;
    throw new MaintenanceStateError("Asynchronous mutation ownership is uncertain; retained ownership requires inspection.");
  }
}
export function assertMaintenanceMutation(root: string): void {
  ensure(typeof root === "string" && root.length > 0); const absolute = resolve(root), lease = frames.get(identity(absolute));
  ensure(lease?.kind === "mutation" && !lease.uncertain); checkLease(lease); noHold(absolute);
}
export function assertMaintenanceAvailable(root: string): void {
  const absolute = canonical(root); noHold(absolute); const own = frames.get(identity(absolute));
  if (own) { ensure(!own.uncertain); checkLease(own); return; }
  if (bytes(maintenanceGatePath(absolute), 2048) !== null) throw new StateLockConflictError("Maintenance boundary is busy or unknown.");
}
/** One synchronous, privately reentrant per-root boundary spanning the entire RMW. */
export function withMaintenanceMutation<T>(root: string, action: () => T): T {
  callback(action); ensure(typeof root === "string" && root.length > 0); const absolute = resolve(root), key = identity(absolute), existing = frames.get(key);
  if (existing) { assertMaintenanceMutation(absolute); const result = action(); assertSynchronousMaintenanceResult(result); assertMaintenanceMutation(absolute); return result; }
  const lease = gate(absolute, "mutation"); frames.set(key, lease);
  try { assertMaintenanceMutation(absolute); const result = action(); assertSynchronousMaintenanceResult(result); assertMaintenanceMutation(absolute); return result; }
  finally { frames.delete(key); if (lease.uncertain) { closeSync(lease.fd); lease.active = false; }
    else { try { ownedRemoval(lease); } catch (error) { if (lease.active) { closeSync(lease.fd); lease.active = false; } throw error; } }
  }
}
function privateLease(proof: unknown, map: WeakMap<object, Lease>, kind?: OwnerKind): Lease {
  ensure(proof !== null && typeof proof === "object" && !nodeTypes.isProxy(proof)); const lease = map.get(proof);
  ensure(lease && (kind === undefined || lease.kind === kind)); checkLease(lease); return lease;
}
function entries(directory: string): string[] {
  safePath(directory, false); let names: string[];
  try { names = readdirSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new MaintenanceStateError(); }
  ensure(names.length <= MAX_OWNERS); return names;
}
function occupants(root: string): number {
  const names = entries(maintenanceOwnersDir(root));
  for (const name of names) {
    ensure(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.json$(?![\s\S])/.test(name) && !name.includes(".."));
    const data = bytes(join(maintenanceOwnersDir(root), name), 2048); ensure(data !== null);
    try { const owner = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as OwnerRecord;
      ensure(validateOwner(owner) && `${owner.id}.json` === name && owner.root_fingerprint === maintenanceRootFingerprint(root));
    } catch { throw new MaintenanceStateError(); }
  }
  return names.length;
}
function coreLocks(root: string): boolean {
  if (entries(root).some((name) => (process.platform === "win32" ? name.toLowerCase() : name).endsWith(".lock"))) return true;
  for (const suffix of [".locks", "locks", "events/.locks", "organization/.locks", "issues/.locks", "portfolio/.locks", "sessions/.locks", "signals/.locks", "harness/.locks"]) {
    if (entries(join(root, suffix)).length !== 0) return true;
  }
  return false;
}
/** Core-only exclusion. This handle is NOT whole-platform quiescence/readiness. */
export function acquireMaintenanceExclusive(root: string): MaintenanceExclusive {
  const lease = gate(root, "exclusive");
  try { if (occupants(lease.root) !== 0 || coreLocks(lease.root)) throw new StateLockConflictError("Active or unknown participants/store locks refuse exclusive maintenance.");
    const proof = Object.freeze({}) as MaintenanceExclusive; exclusives.set(proof, lease); return proof;
  } catch (error) {
    try { ownedRemoval(lease); } finally { if (lease.active) { closeSync(lease.fd); lease.active = false; } }
    throw error;
  }
}
export function releaseMaintenanceExclusive(proof: unknown): void {
  ensure(proof !== null && typeof proof === "object" && !nodeTypes.isProxy(proof)); const lease = exclusives.get(proof);
  ensure(lease?.kind === "exclusive");
  try { ownedRemoval(lease); } finally { if (lease.active) { closeSync(lease.fd); lease.active = false; } exclusives.delete(proof); }
}
export function acquireMaintenanceParticipant(root: string, kind: Exclude<OwnerKind, "mutation" | "exclusive" | "coordination">): MaintenanceParticipant {
  ensure(["api", "worker", "task", "routine", "project-command", "operation"].includes(kind)); const lease = gate(root, "coordination");
  let marker: Lease | undefined, proof: MaintenanceParticipant | undefined;
  try { ensure(occupants(lease.root) < MAX_OWNERS); mkdirSync(maintenanceOwnersDir(lease.root), { recursive: true, mode: 0o700 });
    const owner = ownerRecord(lease.root, kind); marker = openOwner(lease.root, join(maintenanceOwnersDir(lease.root), `${owner.id}.json`), kind, owner);
    proof = Object.freeze({}) as MaintenanceParticipant; participants.set(proof, marker);
    ownedRemoval(lease); return proof;
  } catch (error) {
    if (marker?.active) { closeSync(marker.fd); marker.active = false; }
    if (proof) participants.delete(proof);
    throw error;
  } finally { if (lease.active) { try { ownedRemoval(lease); } catch { if (lease.active) { closeSync(lease.fd); lease.active = false; } } } }
}
export function assertMaintenanceParticipant(proof: unknown): void { const lease = privateLease(proof, participants); noHold(lease.root); }
export function releaseMaintenanceParticipant(proof: unknown): void {
  ensure(proof !== null && typeof proof === "object" && !nodeTypes.isProxy(proof)); const participant = participants.get(proof); ensure(participant);
  try { checkLease(participant); }
  catch (error) { if (participant.active) { closeSync(participant.fd); participant.active = false; } participants.delete(proof); throw error; }
  // Mere coordination contention does not revoke a still-known private owner.
  const coordinator = gate(participant.root, "coordination", true);
  try { ownedRemoval(participant); }
  finally { if (participant.active) { closeSync(participant.fd); participant.active = false; } participants.delete(proof);
    try { ownedRemoval(coordinator); } finally { if (coordinator.active) { closeSync(coordinator.fd); coordinator.active = false; } }
  }
}
/** Durable holds have no release API in T015; journal-bound recovery is later work. */
export function setMaintenanceHold(proof: unknown, input: { operation_id: string; kind: NonNullable<MaintenanceControl["hold"]>["kind"] }): MaintenanceControl {
  const lease = privateLease(proof, exclusives, "exclusive");
  ensure(input !== null && typeof input === "object" && !nodeTypes.isProxy(input) && [Object.prototype, null].includes(Object.getPrototypeOf(input)));
  const descriptors = Object.getOwnPropertyDescriptors(input);
  ensure(descriptors && Reflect.ownKeys(descriptors).length === 2 && ["operation_id", "kind"].every((key) => descriptors[key]?.enumerable && Object.hasOwn(descriptors[key]!, "value")));
  ensure(typeof descriptors.operation_id!.value === "string" && typeof descriptors.kind!.value === "string"
    && ["restore", "rollback", "ownership-review"].includes(descriptors.kind!.value));
  const path = maintenanceControlPath(lease.root), beforeBytes = bytes(path), before = decodeControl(beforeBytes, lease.root), now = new Date().toISOString();
  ensure(before?.hold == null && (before?.revision ?? 0) < Number.MAX_SAFE_INTEGER
    && (before === null || Date.parse(before.updated_at) <= Date.parse(now)));
  const control: MaintenanceControl = { schema_version: 1, revision: (before?.revision ?? 0) + 1, root_fingerprint: maintenanceRootFingerprint(lease.root),
    created_at: before?.created_at ?? now, updated_at: now, hold: { id: randomUUID(), operation_id: descriptors.operation_id!.value, kind: descriptors.kind!.value, created_at: now } };
  ensure(validateControl(control)); const staged = `${path}.${randomUUID()}.tmp`; let fd: number | undefined, stat: Stats | undefined;
  try { checkLease(lease); safePath(path, true); fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); stat = fstatSync(fd);
    writeFileSync(fd, encode(control)); fsyncSync(fd); closeSync(fd); fd = undefined; checkLease(lease); safePath(staged, true); ensure(same(stat, lstatSync(staged)));
    const currentBytes = bytes(path); ensure(beforeBytes === null ? currentBytes === null : currentBytes !== null && beforeBytes.equals(currentBytes));
    renameSync(staged, path); return readMaintenanceControl(lease.root)!;
  } finally { if (fd !== undefined) closeSync(fd); if (stat) { try { safePath(staged, true); if (same(stat, lstatSync(staged))) unlinkSync(staged); } catch { /* Retain unknown or committed files. */ } } }
}
export function readMaintenanceReadiness(root: string = stateDir()) {
  try { const absolute = canonical(root), control = readMaintenanceControl(absolute), owners = occupants(absolute);
    const busy = bytes(maintenanceGatePath(absolute), 2048) !== null || coreLocks(absolute);
    return { schema_version: 1 as const, coverage: "partial" as const, snapshot_ready: false as const, cutover_ready: false as const,
      state: control?.hold ? "held" as const : busy || owners > 0 ? "ownership-unavailable" as const : "idle" as const, participants: owners };
  } catch { return { schema_version: 1 as const, coverage: "partial" as const, snapshot_ready: false as const, cutover_ready: false as const, state: "unavailable" as const, participants: null }; }
}
