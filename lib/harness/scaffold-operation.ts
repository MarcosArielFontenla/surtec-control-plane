import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { PolicyService } from "../policy/service";
import { isSafeIdentifier } from "../security/identifiers";
import { isPathWithin } from "../security/paths";
import {
  readScaffoldOperation, withScaffoldOperationStore, type ScaffoldCheckpoint, type ScaffoldOperation,
} from "../state/harness-scaffold-operations";
import { StateLockConflictError } from "../state/maintenance";
import { scaffoldOperationsDir } from "../state/paths";
import {
  discardUnpublishedScaffoldStage, isScaffoldTemplate, observeScaffoldEntry, prepareScaffoldStage, publishScaffoldStage,
  removeScaffoldCreation, scaffoldDirectoryIdentity, scaffoldStagePath, type ScaffoldTemplatePath,
} from "./scaffold-files";
import { previewRegisteredScaffold } from "./scaffold-project";
import { hash } from "./source";

type Request = Parameters<typeof previewRegisteredScaffold>[1];
type ApplyPlan = Extract<ReturnType<typeof previewRegisteredScaffold>, { status: "available" }>;
type Verification = Extract<ScaffoldCheckpoint, { kind: "verification" }>;
type FileCheckpoint = Extract<ScaffoldCheckpoint, { file_identity_sha256: string }>;
type Approval<T> = (plan: T) => { digest: string; exclusive: boolean } | null | Promise<{ digest: string; exclusive: boolean } | null>;

type RollbackEntry =
  | { path: ScaffoldTemplatePath; action: "already-absent" | "verified-absence"; sha256: null }
  | { path: ScaffoldTemplatePath; action: "preserve-conflict"; sha256: string | null }
  | { path: ScaffoldTemplatePath; action: "remove"; sha256: string; file_identity_sha256: string; file_metadata_sha256: string; recovered: boolean };

function refused(reason: "preview-unavailable" | "not-approved" | "stale-preview" | "busy" | "ownership-conflict") {
  return { status: "refused", reason, operation_id: null } as const;
}

function review(operationId: string | null) {
  return { status: "needs-review", operation_id: operationId } as const;
}

function requireEvidence(condition: unknown): asserts condition {
  if (!condition) throw new Error("Scaffold operation evidence is unavailable");
}

function checkoutFence(root: string) {
  const directories = [root, join(root, ".git"), join(root, ".agents"), join(root, ".agents/templates")];
  const identities = directories.map((path) => scaffoldDirectoryIdentity(path));
  return () => requireEvidence(directories.every((path, index) => scaffoldDirectoryIdentity(path) === identities[index]));
}

async function approved<T>(confirm: Approval<T>, plan: T, digest: string): Promise<boolean> {
  try {
    const decision = await confirm(structuredClone(plan));
    return decision?.digest === digest && decision.exclusive === true;
  } catch { return false; }
}

function recordedAbsence(record: ScaffoldOperation, path: ScaffoldTemplatePath): boolean {
  return record.checkpoints.some((checkpoint) => checkpoint.kind === "absence-observed" && checkpoint.path === path);
}

function findFileCheckpoint(record: ScaffoldOperation, path: ScaffoldTemplatePath, kind: "staged" | "published"): FileCheckpoint | undefined {
  return record.checkpoints.find((checkpoint): checkpoint is FileCheckpoint => checkpoint.kind === kind && checkpoint.path === path);
}

function existingClaim(stateRoot: string, plan: ApplyPlan): string | null {
  const directory = scaffoldOperationsDir(stateRoot);
  if (!lstatSync(directory, { throwIfNoEntry: false })) return null;
  scaffoldDirectoryIdentity(directory);
  for (const id of readdirSync(directory)) {
    const prior = readScaffoldOperation(stateRoot, id);
    requireEvidence(prior);
    if (prior.record.preimage.git.checkout_fingerprint !== plan.git.checkout_fingerprint) continue;
    if (prior.record.preimage.additions.some(({ path }) =>
      plan.additions.some((addition) => addition.path === path) && !recordedAbsence(prior.record, path))) return id;
  }
  return null;
}

function sameOwnership(left: ApplyPlan["entries"][number] | undefined, right: ScaffoldOperation["preimage"]["entries"][number] | undefined): boolean {
  return !!left && !!right && left.ownership === right.ownership && left.ownership_evidence_sha256 === right.ownership_evidence_sha256;
}

function compatibleOwner(entry: ApplyPlan["entries"][number] | undefined): boolean {
  return entry?.ownership === "unknown" || entry?.ownership === "scaffold-managed";
}

function proposedRollbackEntry(root: string, snapshot: ScaffoldOperation, plan: ApplyPlan, addition: ScaffoldOperation["preimage"]["additions"][number]): RollbackEntry {
  const { path } = addition;
  try {
    const file = observeScaffoldEntry(root, path);
    const stage = observeScaffoldEntry(root, scaffoldStagePath(snapshot.operation_id, path));
    const hadAbsence = recordedAbsence(snapshot, path);
    if (stage.proof || (hadAbsence && file.proof)) return { path, action: "preserve-conflict", sha256: file.sha256 };
    if (!file.proof) return { path, action: hadAbsence ? "verified-absence" : "already-absent", sha256: null };
    const recorded = snapshot.preimage.entries.find((entry) => entry.path === path);
    const current = plan.entries.find((entry) => entry.path === path);
    const published = findFileCheckpoint(snapshot, path, "published");
    const staged = findFileCheckpoint(snapshot, path, "staged");
    const proof = file.proof;
    // A missing publication checkpoint can be recovered only from the same birth identity and stable staged metadata.
    const recovered = !published && proof.has_birth_time && staged?.file_identity_sha256 === proof.file_identity_sha256
      && staged.file_metadata_sha256 === proof.staging_metadata_sha256;
    const exactPublication = published?.file_identity_sha256 === proof.file_identity_sha256
      && published.file_metadata_sha256 === proof.file_metadata_sha256;
    if (file.sha256 !== addition.sha256 || current?.observed_sha256 !== file.sha256 || !compatibleOwner(current)
      || !sameOwnership(current, recorded) || (!exactPublication && !recovered)) {
      return { path, action: "preserve-conflict", sha256: file.sha256 };
    }
    return { path, action: "remove", sha256: addition.sha256, file_identity_sha256: proof.file_identity_sha256,
      file_metadata_sha256: proof.file_metadata_sha256, recovered };
  } catch { return { path, action: "preserve-conflict", sha256: null }; }
}

export function createScaffoldOperationService(
  repoRoot: string, stateRoot: string, policy: Pick<PolicyService, "project"> = new PolicyService(repoRoot),
) {
  function observe(input: Request) {
    requireEvidence(isSafeIdentifier(input.projectId));
    const project = policy.project(input.projectId);
    requireEvidence(project.id === input.projectId && project.repo_path && stateRoot.length > 0);
    const root = resolve(project.repo_path);
    requireEvidence(!isPathWithin(root, stateRoot) && !isPathWithin(stateRoot, root));
    const check = checkoutFence(root);
    const plan = previewRegisteredScaffold(repoRoot, input, { project: () => project });
    requireEvidence(plan.status === "available");
    const recheck = () => {
      requireEvidence(policy.project(input.projectId).repo_path === project.repo_path);
      check();
      requireEvidence(!isPathWithin(root, stateRoot) && !isPathWithin(stateRoot, root));
    };
    recheck();
    return { root, plan, recheck };
  }

  function verifyApplied(record: ScaffoldOperation): Verification {
    try {
      const { root, plan, recheck } = observe({ projectId: record.preimage.project_id, selection: record.preimage.archetype_id });
      const matches = isDeepStrictEqual(plan.git, record.preimage.git) && isDeepStrictEqual(plan.source, record.preimage.source)
        && plan.archetype.registry_sha256 === record.preimage.archetype_sha256
        && record.preimage.entries.every((before) => {
          const current = plan.entries.find((entry) => entry.path === before.path);
          if (!current || !sameOwnership(current, before)) return false;
          const addition = record.preimage.additions.find((entry) => entry.path === before.path);
          if (!addition) return current.presence === before.presence && current.observed_sha256 === before.observed_sha256;
          const file = observeScaffoldEntry(root, addition.path);
          const published = findFileCheckpoint(record, addition.path, "published");
          return published && !observeScaffoldEntry(root, scaffoldStagePath(record.operation_id, addition.path)).proof
            && file.sha256 === addition.sha256 && current.observed_sha256 === addition.sha256
            && file.proof?.file_identity_sha256 === published.file_identity_sha256
            && file.proof.file_metadata_sha256 === published.file_metadata_sha256;
        });
      recheck();
      return { kind: "verification", result: matches ? "passed" : "failed", observation_sha256: plan.apply_digest,
        doctor_fingerprint: plan.doctor.project_fingerprint, doctor_validation: plan.doctor.validation.status };
    } catch {
      return { kind: "verification", result: "unknown", observation_sha256: null, doctor_fingerprint: null, doctor_validation: "unknown" };
    }
  }

  function inspect(operationId: string) {
    const loaded = readScaffoldOperation(stateRoot, operationId);
    if (!loaded) return null;
    const { record } = loaded;
    const target = observe({ projectId: record.preimage.project_id, selection: record.preimage.archetype_id });
    requireEvidence(isDeepStrictEqual(record.preimage.git, target.plan.git));
    const paths = record.preimage.additions.map((addition) => proposedRollbackEntry(target.root, record, target.plan, addition));
    target.recheck();
    // Recheck the durable revision after observing the filesystem so status never binds an older receipt.
    requireEvidence(readScaffoldOperation(stateRoot, operationId)?.record.snapshot_sha256 === record.snapshot_sha256);
    const body = { operation_id: operationId, project_id: record.preimage.project_id, revision: record.revision,
      snapshot_sha256: record.snapshot_sha256, git: target.plan.git, current_preview_digest: target.plan.apply_digest, paths };
    const preview = { ...body, rollback_digest: hash(JSON.stringify(body)), execution_authority: "none" } as const;
    return { record, target, preview, conflict: paths.some((path) => path.action === "preserve-conflict") };
  }

  async function apply(input: Request, confirm: Approval<ApplyPlan>) {
    const request = { projectId: input.projectId, selection: input.selection };
    let offered: ApplyPlan;
    try { offered = observe(request).plan; } catch { return refused("preview-unavailable"); }
    if (offered.additions.length === 0) return { status: "no-op", operation_id: null } as const;
    if (offered.additions.some(({ path }) => !compatibleOwner(offered.entries.find((entry) => entry.path === path)))) {
      return refused("ownership-conflict");
    }
    if (!await approved(confirm, offered, offered.apply_digest)) return refused("not-approved");
    let operationId: string | null = null;
    try {
      return withScaffoldOperationStore(stateRoot, (writer) => {
        let target;
        try { target = observe(request); } catch { return refused("stale-preview"); }
        if (target.plan.apply_digest !== offered.apply_digest) return refused("stale-preview");
        const claim = existingClaim(stateRoot, target.plan);
        if (claim) return review(claim);
        const fence = () => { writer.assertActive(); target.recheck(); };
        fence();
        let record = writer.prepare(target.plan);
        operationId = record.operation_id;
        const escrow = readScaffoldOperation(stateRoot, operationId);
        requireEvidence(escrow?.record.snapshot_sha256 === record.snapshot_sha256);
        for (const { path, bytes } of escrow.blobs) {
          requireEvidence(isScaffoldTemplate(path) && bytes);
          record = writer.checkpoint(operationId, record.revision, { kind: "stage-intent", path });
          const staged = prepareScaffoldStage(target.root, operationId, path, bytes, fence);
          try {
            requireEvidence(staged.proof);
            record = writer.checkpoint(operationId, record.revision, { kind: "staged", path,
              file_identity_sha256: staged.proof.file_identity_sha256, file_metadata_sha256: staged.proof.staging_metadata_sha256 });
            const final = publishScaffoldStage(target.root, operationId, path, staged, fence);
            requireEvidence(final.proof);
            record = writer.checkpoint(operationId, record.revision, { kind: "published", path,
              file_identity_sha256: final.proof.file_identity_sha256, file_metadata_sha256: final.proof.file_metadata_sha256 });
          } catch (error) {
            discardUnpublishedScaffoldStage(target.root, operationId, path, staged, fence);
            throw error;
          }
        }
        const verification = verifyApplied(record);
        writer.checkpoint(operationId, record.revision, verification);
        return { status: verification.result === "passed" ? "applied" : "needs-review", operation_id: operationId, verification } as const;
      });
    } catch (error) {
      return error instanceof StateLockConflictError && !operationId ? refused("busy") : review(operationId);
    }
  }

  async function rollback(operationId: string, confirm: Approval<NonNullable<ReturnType<typeof inspect>>["preview"]>) {
    let offered;
    try { offered = inspect(operationId); } catch { return review(operationId); }
    if (!offered || offered.conflict) return review(operationId);
    if (offered.preview.paths.every((path) => path.action === "verified-absence")) return { status: "no-op", operation_id: operationId } as const;
    if (!await approved(confirm, offered.preview, offered.preview.rollback_digest)) return refused("not-approved");
    try {
      return withScaffoldOperationStore(stateRoot, (writer) => {
        const fresh = inspect(operationId);
        if (!fresh || fresh.conflict || fresh.preview.rollback_digest !== offered.preview.rollback_digest) return refused("stale-preview");
        const fence = () => { writer.assertActive(); fresh.target.recheck(); };
        let record = fresh.record;
        const paths = fresh.preview.paths.filter(({ action }) => action !== "verified-absence" && action !== "preserve-conflict");
        for (const path of paths) {
          if (path.action === "remove" && path.recovered) {
            record = writer.checkpoint(operationId, record.revision, { kind: "published", path: path.path,
              file_identity_sha256: path.file_identity_sha256, file_metadata_sha256: path.file_metadata_sha256 });
          }
        }
        record = writer.checkpoint(operationId, record.revision, {
          kind: "rollback-approved", rollback_digest: fresh.preview.rollback_digest, paths: paths.map(({ path }) => path),
        });
        for (const path of paths) {
          fence();
          if (path.action === "remove") {
            record = writer.checkpoint(operationId, record.revision, { kind: "rollback-intent", path: path.path });
            removeScaffoldCreation(fresh.target.root, path.path, path, fence);
          } else {
            requireEvidence(observeScaffoldEntry(fresh.target.root, path.path).sha256 === null
              && observeScaffoldEntry(fresh.target.root, scaffoldStagePath(operationId, path.path)).sha256 === null);
          }
          record = writer.checkpoint(operationId, record.revision, {
            kind: "absence-observed", path: path.path, outcome: path.action === "remove" ? "removed" : "already-absent",
          });
        }
        const after = inspect(operationId);
        requireEvidence(after?.preview.paths.every((path) => path.action === "verified-absence"));
        return { status: "rolled-back", operation_id: operationId } as const;
      });
    } catch (error) {
      return error instanceof StateLockConflictError ? refused("busy") : review(operationId);
    }
  }

  return {
    preview: (input: Request) => previewRegisteredScaffold(repoRoot, input, policy),
    apply,
    status(operationId: string) {
      try {
        const found = inspect(operationId);
        if (!found) return { status: "not-found", operation_id: operationId } as const;
        const verification = found.record.checkpoints.filter((point): point is Verification => point.kind === "verification").at(-1) ?? null;
        const paths = found.preview.paths;
        const complete = paths.every((path) => path.action === "verified-absence");
        const applied = verification?.result === "passed" && verification.observation_sha256 === found.target.plan.apply_digest
          && paths.every((path) => path.action === "remove" && !path.recovered);
        return {
          status: complete ? "rolled-back" : applied ? "applied" : "needs-review",
          operation_id: operationId, revision: found.record.revision, verification, paths,
          rollback: found.conflict ? null : found.preview,
        } as const;
      } catch { return review(operationId); }
    },
    rollback,
  };
}
