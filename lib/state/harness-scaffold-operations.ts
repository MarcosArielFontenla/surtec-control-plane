import Ajv2020 from "ajv/dist/2020.js";
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync,
  type BigIntStats,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { types } from "node:util";
import schema from "../../schemas/harness-scaffold-operation.schema.json";
import { observeScaffoldEntry, scaffoldDirectoryIdentity } from "../harness/scaffold-files";
import type { previewRegisteredScaffold } from "../harness/scaffold-project";
import { hash } from "../harness/source";
import { isSafeIdentifier } from "../security/identifiers";
import {
  acquireMaintenanceExclusive, assertSynchronousMaintenanceResult, maintenanceRootFingerprint, releaseMaintenanceExclusive,
} from "./maintenance";
import { maintenanceGatePath, scaffoldOperationsDir } from "./paths";

type RegisteredPlan = Extract<ReturnType<typeof previewRegisteredScaffold>, { status: "available" }>;
type PlanEntry = Pick<RegisteredPlan["entries"][number], "path" | "presence" | "decision" | "ownership"
  | "ownership_evidence_sha256" | "observed_sha256" | "canonical_sha256" | "git_exclusion">;

const blobNames = {
  ".agents/templates/entity.spec.yaml": "entity-spec.blob",
  ".agents/templates/feature.tasks.md": "feature-tasks.blob",
} as const;
type TemplatePath = keyof typeof blobNames;
type Verification = "passed" | "failed" | "unknown";

export type ScaffoldCheckpoint =
  | { kind: "stage-intent"; path: TemplatePath }
  | { kind: "staged" | "published"; path: TemplatePath; file_identity_sha256: string; file_metadata_sha256: string }
  | { kind: "verification"; result: Verification; observation_sha256: string | null; doctor_fingerprint: string | null; doctor_validation: Verification }
  | { kind: "rollback-approved"; rollback_digest: string; paths: TemplatePath[] }
  | { kind: "rollback-intent"; path: TemplatePath }
  | { kind: "absence-observed"; path: TemplatePath; outcome: "removed" | "already-absent" };

interface ScaffoldPreimage {
  project_id: string;
  archetype_id: "personal@1";
  archetype_sha256: string;
  source: RegisteredPlan["source"];
  scaffold_fingerprint: string;
  apply_digest: string;
  git: RegisteredPlan["git"];
  prior_doctor_fingerprint: string;
  entries: PlanEntry[];
  additions: { path: TemplatePath; preimage: "absent"; sha256: string; byte_count: number }[];
}

export interface ScaffoldOperation {
  schema_version: 1;
  operation_id: string;
  state_root_fingerprint: string;
  revision: number;
  preimage: ScaffoldPreimage;
  preimage_sha256: string;
  checkpoints: ScaffoldCheckpoint[];
  snapshot_sha256: string;
}

interface ScaffoldOperationWriter {
  assertActive(): void;
  prepare(plan: RegisteredPlan): ScaffoldOperation;
  checkpoint(operationId: string, expectedRevision: number, checkpoint: ScaffoldCheckpoint): ScaffoldOperation;
}

type StateErrorCode = "invalid" | "unsupported-version" | "unsafe" | "incomplete" | "conflict" | "write-failed";
export class ScaffoldOperationError extends Error {
  constructor(readonly code: StateErrorCode) {
    super(`Scaffold operation state ${code}. Inspect the retained evidence before retrying.`);
    this.name = "ScaffoldOperationError";
  }
}

const metadataLimit = 64 * 1024;
const blobLimit = 256 * 1024;
const operationIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/;
const validate = new Ajv2020({ strict: true, ownProperties: true }).compile<ScaffoldOperation>(schema);

function requireState(condition: unknown, code: StateErrorCode = "invalid"): asserts condition {
  if (!condition) throw new ScaffoldOperationError(code);
}

function relativeName(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

function operationPath(root: string, id: string): string {
  requireState(operationIdPattern.test(id));
  return join(scaffoldOperationsDir(root), id);
}

function template(path: string): path is TemplatePath {
  return Object.hasOwn(blobNames, path);
}

function preimageSeal(record: Pick<ScaffoldOperation, "operation_id" | "state_root_fingerprint" | "preimage">): string {
  return hash(JSON.stringify([record.operation_id, record.state_root_fingerprint, record.preimage]));
}

function snapshotSeal({ snapshot_sha256: _, ...body }: ScaffoldOperation): string {
  return hash(JSON.stringify(body));
}

function validatePreimage(preimage: ScaffoldPreimage): void {
  requireState(isSafeIdentifier(preimage.project_id));
  const paths = preimage.entries.map((entry) => entry.path);
  requireState(paths.join("\n") === [...Object.keys(blobNames), "AGENTS.md"].join("\n"));
  for (const entry of preimage.entries) {
    requireState((entry.presence === "missing") === (entry.observed_sha256 === null));
    requireState(entry.ownership === "unknown" || entry.ownership_evidence_sha256 !== null);
    if (entry.decision === "safe-addition") requireState(template(entry.path) && entry.presence === "missing");
  }
  const expected = preimage.entries.filter((entry) => entry.decision === "safe-addition" && entry.git_exclusion === null);
  requireState(preimage.additions.length === expected.length && preimage.additions.every((addition, index) =>
    addition.path === expected[index].path && addition.sha256 === expected[index].canonical_sha256));
}

function validateCheckpoints(record: ScaffoldOperation): void {
  const planned = new Set(record.preimage.additions.map(({ path }) => path));
  const staging = new Set<TemplatePath>();
  const staged = new Map<TemplatePath, string>();
  const published = new Set<TemplatePath>();
  const absences = new Set<TemplatePath>();
  const approvedDigests = new Set<string>();
  let applying = true;
  let rollback: { paths: TemplatePath[]; intents: Set<TemplatePath> } | undefined;
  for (const checkpoint of record.checkpoints) {
    if ("path" in checkpoint) requireState(planned.has(checkpoint.path) && !absences.has(checkpoint.path));
    switch (checkpoint.kind) {
      case "stage-intent":
        requireState(applying && !staging.has(checkpoint.path));
        staging.add(checkpoint.path);
        break;
      case "staged":
        requireState(applying && staging.has(checkpoint.path) && !staged.has(checkpoint.path));
        staged.set(checkpoint.path, checkpoint.file_identity_sha256);
        break;
      case "published":
        requireState(!rollback && !published.has(checkpoint.path) && staged.get(checkpoint.path) === checkpoint.file_identity_sha256);
        published.add(checkpoint.path);
        break;
      case "verification":
        requireState(!rollback && (checkpoint.doctor_validation === "unknown" || checkpoint.doctor_fingerprint !== null));
        if (checkpoint.result === "passed") {
          requireState(published.size === planned.size && checkpoint.observation_sha256 !== null && checkpoint.doctor_fingerprint !== null);
        }
        applying = false;
        break;
      case "rollback-approved":
        requireState(!approvedDigests.has(checkpoint.rollback_digest)
          && checkpoint.paths.every((path) => planned.has(path) && !absences.has(path)));
        approvedDigests.add(checkpoint.rollback_digest);
        applying = false;
        rollback = { paths: checkpoint.paths, intents: new Set() };
        break;
      case "rollback-intent":
        requireState(rollback !== undefined && rollback.paths.includes(checkpoint.path)
          && published.has(checkpoint.path) && !rollback.intents.has(checkpoint.path));
        rollback.intents.add(checkpoint.path);
        break;
      case "absence-observed":
        requireState(rollback?.paths.includes(checkpoint.path)
          && (checkpoint.outcome === "already-absent" || rollback.intents.has(checkpoint.path)));
        absences.add(checkpoint.path);
        break;
    }
  }
}

function assertRecord(value: unknown, id: string, rootFingerprint: string): asserts value is ScaffoldOperation {
  const version = (value as { schema_version?: unknown } | null)?.schema_version;
  if (typeof version === "number" && Number.isInteger(version) && version > 1) throw new ScaffoldOperationError("unsupported-version");
  requireState(validate(value));
  requireState(value.operation_id === id && value.state_root_fingerprint === rootFingerprint);
  requireState(value.revision === value.checkpoints.length + 1
    && value.preimage_sha256 === preimageSeal(value) && value.snapshot_sha256 === snapshotSeal(value));
  validatePreimage(value.preimage);
  validateCheckpoints(value);
}

function sameObservation(left: ReturnType<typeof observeScaffoldEntry>, right: ReturnType<typeof observeScaffoldEntry>): boolean {
  return left.identity === right.identity && left.sha256 === right.sha256;
}

function readSnapshot(root: string, id: string) {
  try {
    const rootFingerprint = maintenanceRootFingerprint(root);
    const directory = operationPath(root, id);
    if (!lstatSync(root, { throwIfNoEntry: false })) return null;
    const recordName = relativeName(root, join(directory, "record.json"));
    const observed = observeScaffoldEntry(root, recordName, metadataLimit);
    if (!observed.bytes) {
      requireState(!lstatSync(directory, { throwIfNoEntry: false }), "incomplete");
      return null;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(observed.bytes));
    assertRecord(value, id, rootFingerprint);
    const blobs = value.preimage.additions.map((addition) => {
      const blob = observeScaffoldEntry(root, relativeName(root, join(directory, blobNames[addition.path])), blobLimit);
      requireState(blob.bytes?.length === addition.byte_count && blob.sha256 === addition.sha256);
      return { path: addition.path, bytes: blob.bytes };
    });
    requireState(sameObservation(observed, observeScaffoldEntry(root, recordName, metadataLimit)), "conflict");
    return { record: value, blobs, observed };
  } catch (error) {
    if (error instanceof ScaffoldOperationError) throw error;
    throw new ScaffoldOperationError(error instanceof SyntaxError ? "invalid" : "unsafe");
  }
}

/** Status reads an exact operation and its escrow without acquiring or creating a lock. */
export function readScaffoldOperation(root: string, operationId: string) {
  requireState(root.length > 0, "unsafe");
  const snapshot = readSnapshot(resolve(root), operationId);
  return snapshot === null ? null : { record: snapshot.record, blobs: snapshot.blobs };
}

function objectIdentity(stat: BigIntStats): string {
  requireState(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.ino !== 0n, "unsafe");
  return `${stat.dev}:${stat.ino}`;
}

function removeOwnedTemporary(path: string, parentIdentity: string, identity: string): void {
  try {
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (stat && scaffoldDirectoryIdentity(dirname(path)) === parentIdentity && objectIdentity(stat) === identity) unlinkSync(path);
  } catch { /* Unknown paths retain their evidence. */ }
}

function createPrivateFile(path: string, bytes: Buffer, parentIdentity: string): string {
  requireState(scaffoldDirectoryIdentity(dirname(path)) === parentIdentity, "conflict");
  let identity: string | undefined;
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      identity = objectIdentity(fstatSync(fd, { bigint: true }));
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      return identity;
    } finally { closeSync(fd); }
  } catch {
    if (identity) removeOwnedTemporary(path, parentIdentity, identity);
    throw new ScaffoldOperationError("write-failed");
  }
}

function writeSnapshot(root: string, record: ScaffoldOperation, expected: ReturnType<typeof observeScaffoldEntry>, assertActive: () => void) {
  assertRecord(record, record.operation_id, maintenanceRootFingerprint(root));
  const encoded = Buffer.from(JSON.stringify(record));
  requireState(encoded.length <= metadataLimit);
  const directory = operationPath(root, record.operation_id);
  const parentIdentity = scaffoldDirectoryIdentity(directory);
  const file = join(directory, "record.json");
  const staged = join(directory, `record.${randomUUID()}.tmp`);
  assertActive();
  const stagedIdentity = createPrivateFile(staged, encoded, parentIdentity);
  try {
    const stagedFile = observeScaffoldEntry(root, relativeName(root, staged), metadataLimit);
    requireState(stagedFile.bytes?.equals(encoded), "write-failed");
    const observed = observeScaffoldEntry(root, relativeName(root, file), metadataLimit);
    requireState(sameObservation(expected, observed), "conflict");
    requireState(scaffoldDirectoryIdentity(directory) === parentIdentity
      && objectIdentity(lstatSync(staged, { bigint: true })) === stagedIdentity, "conflict");
    assertActive();
    renameSync(staged, file);
    const saved = readSnapshot(root, record.operation_id);
    requireState(saved?.record.snapshot_sha256 === record.snapshot_sha256, "write-failed");
    return saved.record;
  } catch (error) {
    if (error instanceof ScaffoldOperationError) throw error;
    throw new ScaffoldOperationError("write-failed");
  } finally { removeOwnedTemporary(staged, parentIdentity, stagedIdentity); }
}

function prepare(root: string, plan: RegisteredPlan, assertActive: () => void): ScaffoldOperation {
  const { status, apply_digest, execution_authority, ...payload } = plan;
  requireState(status === "available" && execution_authority === "none" && apply_digest === hash(JSON.stringify(payload)));
  const blobs = plan.additions.map(({ path, text, sha256, preimage }) => {
    requireState(template(path) && typeof text === "string" && Buffer.byteLength(text) <= blobLimit);
    const bytes = Buffer.from(text);
    requireState(hash(bytes) === sha256);
    return { bytes, addition: { path, preimage, sha256, byte_count: bytes.length } };
  });
  const record: ScaffoldOperation = {
    schema_version: 1,
    operation_id: randomUUID(),
    state_root_fingerprint: maintenanceRootFingerprint(root),
    revision: 1,
    preimage: {
      project_id: plan.project_id, archetype_id: plan.archetype.id, archetype_sha256: plan.archetype.registry_sha256,
      source: plan.source, scaffold_fingerprint: plan.scaffold_fingerprint, apply_digest,
      git: plan.git, prior_doctor_fingerprint: plan.doctor.project_fingerprint,
      entries: plan.entries.map(({ path, presence, decision, ownership, ownership_evidence_sha256, observed_sha256, canonical_sha256, git_exclusion }) =>
        ({ path, presence, decision, ownership, ownership_evidence_sha256, observed_sha256, canonical_sha256, git_exclusion })),
      additions: blobs.map(({ addition }) => addition),
    },
    preimage_sha256: "",
    checkpoints: [],
    snapshot_sha256: "",
  };
  record.preimage_sha256 = preimageSeal(record);
  record.snapshot_sha256 = snapshotSeal(record);
  assertRecord(record, record.operation_id, record.state_root_fingerprint);
  assertActive();
  for (const path of [dirname(scaffoldOperationsDir(root)), scaffoldOperationsDir(root)]) {
    if (!lstatSync(path, { throwIfNoEntry: false })) mkdirSync(path, { mode: 0o700 });
    scaffoldDirectoryIdentity(path);
  }
  const directory = operationPath(root, record.operation_id);
  mkdirSync(directory, { mode: 0o700 });
  const parentIdentity = scaffoldDirectoryIdentity(directory);
  for (const { bytes, addition } of blobs) {
    assertActive();
    const file = join(directory, blobNames[addition.path]);
    createPrivateFile(file, bytes, parentIdentity);
    requireState(observeScaffoldEntry(root, relativeName(root, file), blobLimit).sha256 === addition.sha256, "write-failed");
  }
  const missing = observeScaffoldEntry(root, relativeName(root, join(directory, "record.json")), metadataLimit);
  requireState(missing.bytes === null, "conflict");
  return writeSnapshot(root, record, missing, assertActive);
}

/** The writer is valid only during this synchronous maintenance-exclusive window. */
export function withScaffoldOperationStore<T>(stateRoot: string, action: (writer: ScaffoldOperationWriter) => T): T {
  requireState(stateRoot.length > 0, "unsafe");
  requireState(typeof action === "function" && !types.isProxy(action)
    && !types.isAsyncFunction(action) && !types.isGeneratorFunction(action));
  const root = resolve(stateRoot);
  const exclusive = acquireMaintenanceExclusive(root);
  let active = true;
  try {
    const gateName = relativeName(root, maintenanceGatePath(root));
    const gate = observeScaffoldEntry(root, gateName, 2048);
    requireState(gate.bytes !== null, "conflict");
    const assertActive = () => {
      requireState(active && sameObservation(gate, observeScaffoldEntry(root, gateName, 2048)), "conflict");
    };
    const writer: ScaffoldOperationWriter = {
      assertActive,
      prepare: (plan) => prepare(root, plan, assertActive),
      checkpoint(id, expectedRevision, checkpoint) {
        assertActive();
        const before = readSnapshot(root, id);
        requireState(before !== null && before.record.revision === expectedRevision, "conflict");
        const record = {
          ...before.record,
          revision: expectedRevision + 1,
          checkpoints: [...before.record.checkpoints, structuredClone(checkpoint)],
        };
        record.snapshot_sha256 = snapshotSeal(record);
        return writeSnapshot(root, record, before.observed, assertActive);
      },
    };
    const result = action(Object.freeze(writer));
    assertSynchronousMaintenanceResult(result);
    assertActive();
    return result;
  } finally {
    active = false;
    releaseMaintenanceExclusive(exclusive);
  }
}
