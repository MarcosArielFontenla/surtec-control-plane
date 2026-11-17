import {
  fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectProjectArchetype } from "../harness/archetypes";
import { scaffoldDirectoryIdentity } from "../harness/scaffold-files";
import type { previewRegisteredScaffold } from "../harness/scaffold-project";
import { hash } from "../harness/source";
import { readScaffoldOperation, withScaffoldOperationStore, type ScaffoldCheckpoint, type ScaffoldOperation } from "./harness-scaffold-operations";
import { acquireMaintenanceParticipant, releaseMaintenanceParticipant, StateLockConflictError } from "./maintenance";
import { maintenanceGatePath, scaffoldOperationsDir } from "./paths";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync) };
});

type Plan = Extract<ReturnType<typeof previewRegisteredScaffold>, { status: "available" }>;
const repoRoot = resolve(".");
const spec = ".agents/templates/entity.spec.yaml";
const tasks = ".agents/templates/feature.tasks.md";
const roots: { root: string; parent: string; identity: string }[] = [];

afterEach(() => {
  vi.mocked(renameSync).mockReset();
  vi.mocked(fsyncSync).mockReset();
  for (const { root, parent, identity } of roots.splice(0)) {
    if (dirname(root) !== parent || scaffoldDirectoryIdentity(root) !== identity) throw new Error("Unverified fixture root");
    rmSync(root, { recursive: true });
    expect(lstatSync(root, { throwIfNoEntry: false })).toBeUndefined();
  }
});

function fixture() {
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, "surtec-scaffold-state-"));
  roots.push({ root, parent, identity: scaffoldDirectoryIdentity(root) });
  return join(root, "state");
}

function sign(plan: Plan): Plan {
  const { status, apply_digest: _, execution_authority, ...body } = plan;
  return { status, ...body, apply_digest: hash(JSON.stringify(body)), execution_authority };
}

function plan(): Plan {
  const additions = [spec, tasks].map((path) => {
    const bytes = readFileSync(join(repoRoot, path));
    return { path, text: bytes.toString("utf8"), sha256: hash(bytes), preimage: "absent" as const };
  });
  const observation = hash("fixture observation");
  return sign({
    status: "available", schema_version: 1, project_id: "fixture",
    archetype: selectProjectArchetype(repoRoot, "personal@1"),
    source: { id: "surtec-h1-h4", version: "surtec-h1-h4-v1", fingerprint: hash("source") },
    scaffold_fingerprint: hash("preview"),
    git: {
      checkout_fingerprint: hash("checkout"), template_parent_fingerprint: hash("parent"),
      head: "a".repeat(40), branch: "refs/heads/main", index_sha256: null, index_entries_sha256: hash("index"),
    },
    entries: [
      ...additions.map(({ path, sha256 }) => ({
        path, presence: "missing" as const, decision: "safe-addition" as const, canonical_sha256: sha256,
        action: "plan-addition" as const, ownership: "unknown" as const, ownership_evidence_sha256: null,
        observed_sha256: null, observed_physical_lines: null, canonical_physical_lines: 26, git_exclusion: null,
      })),
      {
        path: "AGENTS.md", presence: "present", decision: "user-owned-conflict", canonical_sha256: hash("canonical primer"),
        action: "preserve-and-review-conflict", ownership: "user-owned", ownership_evidence_sha256: hash("declaration"),
        observed_sha256: hash("private working primer"), observed_physical_lines: 1, canonical_physical_lines: 25, git_exclusion: null,
      },
    ],
    additions,
    doctor: { status: "legacy", doctor_status: "warning", comparison: "unknown", detected_version: null, project_fingerprint: observation, validation: { status: "unknown", observed_at: null } },
    validation: { status: "unknown", expected: ["canonical-template-sha256", "harness-structure", "context-budget"] },
    routing: { updated: false, added_active_context_lines: 0, added_physical_lines: 52 },
    backup: { paths: [], fingerprint: hash("[]") },
    rollback: { additions: additions.map(({ path, sha256 }) => ({ path, expected_sha256: sha256 })), requires_unchanged_ownership_and_sha256: true },
    apply_digest: "", execution_authority: "none",
  });
}

function prepare(root: string): ScaffoldOperation {
  return withScaffoldOperationStore(root, (writer) => writer.prepare(plan()));
}

function recordPath(root: string, record: ScaffoldOperation): string {
  return join(scaffoldOperationsDir(root), record.operation_id, "record.json");
}

function stage(path: typeof spec | typeof tasks, kind: "staged" | "published"): ScaffoldCheckpoint {
  return { kind, path, file_identity_sha256: hash(path), file_metadata_sha256: hash(path + kind) };
}

function verify(result: "passed" | "failed" | "unknown"): ScaffoldCheckpoint {
  return { kind: "verification", result, observation_sha256: hash("verification"), doctor_fingerprint: hash("doctor"), doctor_validation: "unknown" };
}

function append(root: string, record: ScaffoldOperation, ...checkpoints: ScaffoldCheckpoint[]): ScaffoldOperation {
  return withScaffoldOperationStore(root, (writer) => checkpoints.reduce((current, checkpoint) =>
    writer.checkpoint(record.operation_id, current.revision, checkpoint), record));
}

function reseal(record: ScaffoldOperation): string {
  record.preimage_sha256 = hash(JSON.stringify([record.operation_id, record.state_root_fingerprint, record.preimage]));
  const { snapshot_sha256: _, ...body } = record;
  record.snapshot_sha256 = hash(JSON.stringify(body));
  return JSON.stringify(record);
}

describe("scaffold operation journal", () => {
  it("seals absence, source, Git and observed ownership, and reopens exact escrow bytes", () => {
    const root = fixture();
    const original = plan();
    const record = withScaffoldOperationStore(root, (writer) => writer.prepare(original));
    expect(record).toMatchObject({
      schema_version: 1, revision: 1, checkpoints: [],
      preimage: {
        apply_digest: original.apply_digest, git: original.git, source: original.source,
        prior_doctor_fingerprint: original.doctor.project_fingerprint,
        entries: [{ path: spec, observed_sha256: null }, { path: tasks, observed_sha256: null }, {
          path: "AGENTS.md", ownership: "user-owned", ownership_evidence_sha256: hash("declaration"),
        }],
      },
    });
    const file = recordPath(root, record);
    const before = readFileSync(file);
    expect(before.toString("utf8")).not.toContain("private working primer");
    expect(readScaffoldOperation(root, record.operation_id)).toEqual({
      record, blobs: original.additions.map(({ path, text }) => ({ path, bytes: Buffer.from(text) })),
    });
    expect(readFileSync(file)).toEqual(before);
    expect(lstatSync(maintenanceGatePath(root), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("retains all checkpoints through publish, verification and independently recorded rollback", () => {
    const root = fixture();
    const record = prepare(root);
    const notes: ScaffoldCheckpoint[] = [
      { kind: "stage-intent", path: spec }, stage(spec, "staged"), stage(spec, "published"),
      { kind: "stage-intent", path: tasks }, stage(tasks, "staged"), stage(tasks, "published"),
      verify("passed"),
      { kind: "rollback-approved", rollback_digest: hash("rollback preview"), paths: [spec, tasks] },
      { kind: "rollback-intent", path: spec }, { kind: "absence-observed", path: spec, outcome: "removed" },
      { kind: "absence-observed", path: tasks, outcome: "already-absent" },
    ];
    const latest = append(root, record, ...notes);
    expect(latest.revision).toBe(notes.length + 1);
    expect(latest.preimage_sha256).toBe(record.preimage_sha256);
    expect(latest.preimage).toEqual(record.preimage);
    expect(latest.snapshot_sha256).not.toBe(record.snapshot_sha256);
    expect(readScaffoldOperation(root, record.operation_id)?.record.checkpoints).toEqual(notes);
  });

  it("retains the exact partial checkpoint after interruption and rejects a stale revision", () => {
    const root = fixture();
    const record = prepare(root);
    expect(() => withScaffoldOperationStore(root, (writer) => {
      const intent = writer.checkpoint(record.operation_id, record.revision, { kind: "stage-intent", path: spec });
      writer.checkpoint(record.operation_id, intent.revision, stage(spec, "staged"));
      throw new Error("Simulated stop before publication");
    })).toThrow("Simulated stop before publication");
    const partial = readScaffoldOperation(root, record.operation_id)?.record;
    expect(partial).toMatchObject({ revision: 3, checkpoints: [{ kind: "stage-intent", path: spec }, stage(spec, "staged")] });
    expect(() => append(root, record, stage(spec, "published"))).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(readScaffoldOperation(root, record.operation_id)?.record).toEqual(partial);
  });

  it("rejects out-of-order publication, unproven PASS and rollback without a fresh digest", () => {
    const root = fixture();
    const record = prepare(root);
    for (const invalid of [stage(spec, "published"), verify("passed"), { kind: "absence-observed", path: spec, outcome: "removed" }] as const) {
      expect(() => append(root, record, invalid)).toThrow(expect.objectContaining({ code: "invalid" }));
    }
    const rollback = { kind: "rollback-approved", rollback_digest: hash("new scope"), paths: [tasks] } as const;
    const approved = append(root, record, { ...rollback, paths: [...rollback.paths] });
    expect(() => append(root, approved, { ...rollback, paths: [...rollback.paths] })).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(() => append(root, approved, { kind: "absence-observed", path: spec, outcome: "already-absent" })).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(readScaffoldOperation(root, record.operation_id)?.record).toEqual(approved);
  });

  it("requires the published identity to match the staged checkpoint", () => {
    const root = fixture();
    const base = prepare(root);
    const staged = append(root, base, { kind: "stage-intent", path: spec }, stage(spec, "staged"));
    expect(() => append(root, staged, {
      kind: "published", path: spec, file_identity_sha256: hash("replacement"), file_metadata_sha256: hash("metadata"),
    })).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(readScaffoldOperation(root, base.operation_id)?.record).toEqual(staged);
  });

  it("creates nothing for a changed digest, mismatched pins or an empty apply", () => {
    const root = fixture();
    const stale = plan();
    stale.additions[0] = { ...stale.additions[0], text: "Different bytes" };
    const repacked = sign(stale);
    const empty = sign({ ...plan(), additions: [] });
    for (const invalid of [stale, repacked, empty]) {
      expect(() => withScaffoldOperationStore(root, (writer) => writer.prepare(invalid))).toThrow(expect.objectContaining({ code: "invalid" }));
    }
    expect(lstatSync(scaffoldOperationsDir(root), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("returns null for an absent operation and reports an incomplete one without repairing it", () => {
    const root = fixture();
    const absent = "e8bb4ba4-09dc-4825-83d6-7bd2b6560560";
    expect(readScaffoldOperation(root, absent)).toBeNull();
    expect(lstatSync(root, { throwIfNoEntry: false })).toBeUndefined();
    expect(() => readScaffoldOperation(root, "../elsewhere")).toThrow(expect.objectContaining({ code: "invalid" }));
    const directory = join(scaffoldOperationsDir(root), absent);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "entity-spec.blob"), "retained evidence");
    expect(() => readScaffoldOperation(root, absent)).toThrow(expect.objectContaining({ code: "incomplete" }));
    expect(readdirSync(directory)).toEqual(["entity-spec.blob"]);
  });

  it.each(["malformed", "future-version", "changed-seal", "resealed-out-of-scope"])("preserves %s metadata bytes and refuses to update", (fault) => {
    const root = fixture();
    const record = prepare(root);
    const file = recordPath(root, record);
    let bytes = "{broken";
    if (fault === "future-version") bytes = JSON.stringify({ ...record, schema_version: 2 });
    if (fault === "changed-seal") bytes = JSON.stringify({ ...record, preimage_sha256: hash("wrong seal") });
    if (fault === "resealed-out-of-scope") {
      record.preimage.entries[0].observed_sha256 = hash("present even though declared missing");
      bytes = reseal(record);
    }
    writeFileSync(file, bytes);
    const code = fault === "future-version" ? "unsupported-version" : "invalid";
    expect(() => readScaffoldOperation(root, record.operation_id)).toThrow(expect.objectContaining({ code }));
    expect(() => append(root, record, { kind: "stage-intent", path: spec })).toThrow(expect.objectContaining({ code }));
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });

  it.each(["missing", "changed", "hard-linked"])("refuses an escrow file that is %s", (fault) => {
    const root = fixture();
    const record = prepare(root);
    const file = recordPath(root, record);
    const original = readFileSync(file);
    const blob = join(dirname(file), "entity-spec.blob");
    if (fault === "missing") unlinkSync(blob);
    if (fault === "changed") writeFileSync(blob, "foreign edit");
    if (fault === "hard-linked") linkSync(blob, join(dirname(root), "other-name"));
    const code = fault === "hard-linked" ? "unsafe" : "invalid";
    expect(() => readScaffoldOperation(root, record.operation_id)).toThrow(expect.objectContaining({ code }));
    expect(readFileSync(file)).toEqual(original);
  });

  it.each(["flush", "replace"])("keeps the previous revision on a failed %s and removes only its staged metadata", (fault) => {
    const root = fixture();
    const record = prepare(root);
    const file = recordPath(root, record);
    const expected = readFileSync(file);
    withScaffoldOperationStore(root, (writer) => {
      const io = fault === "flush" ? vi.mocked(fsyncSync) : vi.mocked(renameSync);
      io.mockImplementationOnce(() => { throw new Error("injected IO fault"); });
      expect(() => writer.checkpoint(record.operation_id, record.revision, { kind: "stage-intent", path: spec }))
        .toThrow(expect.objectContaining({ code: "write-failed" }));
    });
    expect(readFileSync(file)).toEqual(expected);
    expect(readdirSync(dirname(file)).sort()).toEqual(["entity-spec.blob", "feature-tasks.blob", "record.json"]);
    expect(readScaffoldOperation(root, record.operation_id)?.record.revision).toBe(1);
  });

  it("leaves escrow inspectable after a crash before initial metadata publication", () => {
    const root = fixture();
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("injected initial publication fault"); });
    expect(() => prepare(root)).toThrow(expect.objectContaining({ code: "write-failed" }));
    const [id] = readdirSync(scaffoldOperationsDir(root));
    expect(readdirSync(join(scaffoldOperationsDir(root), id)).sort()).toEqual(["entity-spec.blob", "feature-tasks.blob"]);
    expect(() => readScaffoldOperation(root, id)).toThrow(expect.objectContaining({ code: "incomplete" }));
  });

  it("refuses a competing participant and invalidates writer methods outside their synchronous window", () => {
    const root = fixture();
    const active = acquireMaintenanceParticipant(root, "worker");
    try {
      expect(() => prepare(root)).toThrow(StateLockConflictError);
      expect(lstatSync(scaffoldOperationsDir(root), { throwIfNoEntry: false })).toBeUndefined();
    } finally { releaseMaintenanceParticipant(active); }
    const writer = withScaffoldOperationStore(root, (current) => {
      expect(() => prepare(root)).toThrow(StateLockConflictError);
      return current;
    });
    expect(() => writer.prepare(plan())).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(lstatSync(maintenanceGatePath(root), { throwIfNoEntry: false })).toBeUndefined();
  });
});
