import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { createScaffoldOperationService } from "../lib/harness/scaffold-operation";
import { previewRegisteredScaffold } from "../lib/harness/scaffold-project";
import { hash, loadHarnessSource } from "../lib/harness/source";
import { PolicyService } from "../lib/policy/service";
import { readScaffoldOperation } from "../lib/state/harness-scaffold-operations";
import { createScaffoldCliFixture, scaffoldFixtureMissingTemplate, scaffoldFixtureProjectId } from "./testing/scaffold-cli-fixture";

const spec = scaffoldFixtureMissingTemplate;
const tasks = ".agents/templates/feature.tasks.md";
const request = { projectId: scaffoldFixtureProjectId, selection: "personal@1" };
const userText = "Synthetic user template with independently maintained instructions.";
const ownershipEvidence = "Synthetic operator declaration for the user template.";
type Fixture = ReturnType<typeof createScaffoldCliFixture>;
type ApplyPlan = Extract<ReturnType<typeof previewRegisteredScaffold>, { status: "available" }>;

function inventory(root: string) {
  return new Map(readdirSync(root, { recursive: true, encoding: "utf8" }).sort().map((path) => {
    const file = join(root, path);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Unexpected fixture entry at ${path}.`);
    return [path.replaceAll("\\", "/"), stat.isDirectory() ? null : hash(readFileSync(file))] as const;
  }));
}

function observeFile(path: string) {
  const stat = lstatSync(path, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, mtimeNs: stat.mtimeNs, bytes: readFileSync(path) };
}

function configureOwnership({ control }: Fixture) {
  const source = loadHarnessSource(control);
  if (source.status !== "trusted" || !source.registry || !source.manifest) throw new Error("The reviewed source is unavailable.");
  const pin = source.manifest.expected_entries.find(({ path }) => path === spec);
  if (!pin) throw new Error("The conflicting template is not pinned in the fixture.");
  const registry = source.registry;
  registry.projects[request.projectId] = {
    ownership: [{ path: spec, classification: "user-owned", evidence: ownershipEvidence }],
    testing_policy: {
      schema_version: 1, mode: "functional", runner_id: null, requires_red_evidence: false, applicable_task_kinds: [],
    },
    review_policy: "unknown", backup_ready: false, rollback_ready: false, validation: null,
  };
  writeFileSync(join(control, "registry/harness-sources.yml"), stringify(registry));
  expect(loadHarnessSource(control)).toMatchObject({ status: "trusted", manifest: source.manifest });
  return pin.sha256;
}

async function withFixture(check: (fixture: Fixture, canonicalSpec: string, policy: PolicyService) => Promise<void>) {
  const fixture = createScaffoldCliFixture();
  try {
    const canonicalSpec = configureOwnership(fixture);
    const policy = new PolicyService(fixture.control, { environment: fixture.environment });
    expect(existsSync(fixture.state)).toBe(false);
    await check(fixture, canonicalSpec, policy);
  } finally {
    fixture.dispose();
  }
}

function expectedConflict(canonicalSpec: string) {
  return {
    path: spec, presence: "present", decision: "user-owned-conflict", action: "preserve-and-review-conflict",
    ownership: "user-owned", ownership_evidence_sha256: hash(ownershipEvidence),
    observed_sha256: hash(userText), canonical_sha256: canonicalSpec,
  };
}

function expectConflict(plan: ApplyPlan, canonicalSpec: string) {
  expect(plan.entries.find(({ path }) => path === spec)).toMatchObject(expectedConflict(canonicalSpec));
  expect(plan.additions.some(({ path }) => path === spec)).toBe(false);
  expect(plan.rollback.additions.some(({ path }) => path === spec)).toBe(false);
  expect(JSON.stringify(plan)).not.toContain(userText);
  expect(JSON.stringify(plan)).not.toContain(ownershipEvidence);
}

function availablePreview(fixture: Fixture, policy: PolicyService) {
  const plan = previewRegisteredScaffold(fixture.control, request, policy);
  expect(plan.status).toBe("available");
  if (plan.status !== "available") throw new Error(`Registered scaffold preview failed: ${plan.reason}`);
  expect(plan.execution_authority).toBe("none");
  return plan;
}

describe("org.harness.scaffold-ownership-conflict", () => {
  it("preserves an unresolved conflict and performs no apply when there are no eligible additions", async () => {
    await withFixture(async (fixture, canonicalSpec, policy) => {
      const path = join(fixture.target, spec);
      writeFileSync(path, userText, { flag: "wx" });
      expect(readFileSync(join(fixture.target, tasks))).toEqual(readFileSync(join(fixture.control, tasks)));
      const before = inventory(fixture.root);
      const original = observeFile(path);
      const plan = availablePreview(fixture, policy);
      expectConflict(plan, canonicalSpec);
      expect(plan.additions).toEqual([]);
      expect(plan.rollback.additions).toEqual([]);
      expect(inventory(fixture.root)).toEqual(before);

      const service = createScaffoldOperationService(fixture.control, fixture.state, policy);
      const approve = vi.fn(() => null);
      expect(await service.apply(request, approve)).toEqual({ status: "no-op", operation_id: null });
      expect(approve).not.toHaveBeenCalled();
      expect(inventory(fixture.root)).toEqual(before);
      expect(observeFile(path)).toEqual(original);
      expect(existsSync(fixture.state)).toBe(false);
    });
  });

  it("applies only the independently approved template and retains the conflict", async () => {
    await withFixture(async (fixture, canonicalSpec, policy) => {
      const path = join(fixture.target, spec);
      writeFileSync(path, userText, { flag: "wx" });
      unlinkSync(join(fixture.target, tasks));
      const original = observeFile(path);
      const sourceBefore = inventory(fixture.control);
      const targetBefore = inventory(fixture.target);
      const canonicalTasks = readFileSync(join(fixture.control, tasks));
      const tasksPin = hash(canonicalTasks);
      const service = createScaffoldOperationService(fixture.control, fixture.state, policy);

      const approve = vi.fn((plan: ApplyPlan) => {
        expectConflict(plan, canonicalSpec);
        expect(plan.additions).toEqual([{ path: tasks, text: canonicalTasks.toString("utf8"), sha256: tasksPin, preimage: "absent" }]);
        expect(plan.rollback.additions).toEqual([{ path: tasks, expected_sha256: tasksPin }]);
        expect(inventory(fixture.target)).toEqual(targetBefore);
        expect(existsSync(fixture.state)).toBe(false);
        return { digest: plan.apply_digest, exclusive: true };
      });
      const result = await service.apply(request, approve);
      expect(result).toMatchObject({ status: "applied", verification: { result: "passed" } });
      expect(approve).toHaveBeenCalledOnce();
      if (!result.operation_id) throw new Error("The successful apply did not return an operation ID.");
      const sealed = readScaffoldOperation(fixture.state, result.operation_id);
      expect(sealed).toMatchObject({
        record: {
          preimage: {
            apply_digest: approve.mock.calls[0]![0].apply_digest,
            entries: expect.arrayContaining([expect.objectContaining({
              path: spec, decision: "user-owned-conflict", ownership: "user-owned",
              observed_sha256: hash(userText), canonical_sha256: canonicalSpec, ownership_evidence_sha256: hash(ownershipEvidence),
            })]),
            additions: [{ path: tasks, preimage: "absent", sha256: tasksPin, byte_count: canonicalTasks.length }],
          },
        },
        blobs: [{ path: tasks, bytes: canonicalTasks }],
      });

      const after = availablePreview(fixture, policy);
      expectConflict(after, canonicalSpec);
      expect(after.additions).toEqual([]);
      expect(readFileSync(join(fixture.target, tasks))).toEqual(canonicalTasks);
      expect(observeFile(path)).toEqual(original);
      expect(inventory(fixture.target)).toEqual(new Map([...targetBefore, [tasks, tasksPin]]));
      expect(inventory(fixture.control)).toEqual(sourceBefore);
    });
  });

  it("refuses a missing path with user ownership before asking for approval", async () => {
    await withFixture(async (fixture, canonicalSpec, policy) => {
      const path = join(fixture.target, spec);
      expect(existsSync(path)).toBe(false);
      expect(readFileSync(join(fixture.target, tasks))).toEqual(readFileSync(join(fixture.control, tasks)));
      const before = inventory(fixture.root);
      const plan = availablePreview(fixture, policy);
      expect(plan.entries.find((entry) => entry.path === spec)).toMatchObject({
        path: spec, presence: "missing", ownership: "user-owned", ownership_evidence_sha256: hash(ownershipEvidence),
        canonical_sha256: canonicalSpec, observed_sha256: null,
      });
      expect(plan.additions).toMatchObject([{ path: spec, sha256: canonicalSpec }]);
      expect(JSON.stringify(plan)).not.toContain(ownershipEvidence);
      expect(inventory(fixture.root)).toEqual(before);

      const service = createScaffoldOperationService(fixture.control, fixture.state, policy);
      const approve = vi.fn(() => null);
      expect(await service.apply(request, approve)).toEqual({
        status: "refused", reason: "ownership-conflict", operation_id: null,
      });
      expect(approve).not.toHaveBeenCalled();
      expect(inventory(fixture.root)).toEqual(before);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(fixture.state)).toBe(false);
    });
  });
});
