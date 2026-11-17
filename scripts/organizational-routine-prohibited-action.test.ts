import { throws } from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRoutineService, RoutineServiceError, type RoutineConfigureInput } from "../dashboard/src/server/routine-service";
import { resolveOccurrenceBudgetAttribution, type BudgetPolicySource } from "../lib/budgets/policy";
import { BUDGET_DIMENSIONS, type BudgetAmounts, type BudgetLimits } from "../lib/budgets/types";
import type { OrganizationSnapshot } from "../lib/organization";
import type { RoutineActionEvidence } from "../lib/routines/actions";
import { routineRevisionKey } from "../lib/routines/schedule";
import type { RoutineRecord } from "../lib/routines/types";
import { assertRoutineDocument, RoutineContractError } from "../lib/routines/validation";
import { readBudgetLedger } from "../lib/state/budgets";
import { budgetStatePath, issueStatePath, routineStatePath, tasksDir } from "../lib/state/paths";
import { readRoutineDocument, RoutineStateError } from "../lib/state/routines";
import { RoutineRunner } from "../runner/routine-runner";
import { createRolePolicyFixture, roleFixtureProject } from "./testing/role-policy-fixture";

const policyFingerprint = "a".repeat(64);
const evidenceFingerprint = "b".repeat(64);
const workerId = "fixture-routine-worker";
const organization: OrganizationSnapshot = {
  company: {
    schema_version: 1, id: "surtec", display_name: "Synthetic company", mission: null,
    operating_principles: [], active_objective_ids: [], last_reviewed_at: null,
  },
  objectives: [],
  project_objectives: {},
};
const hardCaps: Partial<BudgetAmounts> = { attempts: 1, concurrent_reads: 1, runtime_ms: 1_000 };
const limits = Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => {
  const hardCap = hardCaps[dimension];
  return [dimension, hardCap === undefined ? { status: "unconfigured" } : { status: "configured", hard_cap: hardCap }];
})) as BudgetLimits;
const policy: BudgetPolicySource = {
  fingerprint: policyFingerprint,
  policy: {
    schema_version: 1, revision: 1, pricing: { status: "unavailable", reason: "no-versioned-source" },
    rules: [{ id: "company-policy", revision: 1, scope: { kind: "company", id: "surtec" }, period: "none", warning_percent: 80, limits }],
  },
};

function manualConfiguration(record: RoutineRecord): RoutineConfigureInput {
  return {
    expected_revision: record.revision, action: "refresh-evidence", scope: record.scope,
    enabled: true, schedule: null, concurrency: "skip", catch_up: "skip-missed",
  };
}

function setupRoutine(fixture: ReturnType<typeof createRolePolicyFixture>) {
  let nowMs = Date.parse("2026-11-17T12:00:00.000Z");
  const clock = () => new Date(nowMs);
  const readPolicy = vi.fn(() => policy);
  const service = createRoutineService(fixture.root, {
    stateRoot: fixture.state, clock, readBudgetPolicy: readPolicy, readOrganization: () => organization,
    listProjects: () => [{ id: roleFixtureProject }],
  });
  const draft = service.create({ action: "refresh-evidence", scope: { kind: "project", id: roleFixtureProject } }).routine;
  nowMs += 1_000;
  const routine = service.configure(draft.id, manualConfiguration(draft)).routine;
  expect(routine).toMatchObject({ revision: 2, action: "refresh-evidence", enabled: true, schedule: null });
  readPolicy.mockClear();
  nowMs += 1_000;

  const resolvePolicy = vi.fn((_definition: Readonly<RoutineRecord>, executionId: string) => ({
    source: policy, attribution: resolveOccurrenceBudgetAttribution({
      organization, project_ids: [roleFixtureProject], objective_id: null, execution_id: executionId,
    }),
  }));
  const assertCurrent = vi.fn();
  const readEvidence = vi.fn(async (): Promise<RoutineActionEvidence> => ({
    sources: [{ kind: "organization", project_id: null, state: "fresh", observed_at: clock().toISOString(), fingerprint: evidenceFingerprint }],
    signals: [],
  }));
  const proposeIssue = vi.fn(() => { throw new Error("The EVAL cannot create an issue proposal."); });
  const assertReportPrivacy = vi.fn(() => { throw new Error("The EVAL cannot publish a routine report."); });
  const runner = new RoutineRunner({
    stateRoot: fixture.state, now: clock,
    execution: {
      resolve: resolvePolicy, assert_current: assertCurrent, read_evidence: readEvidence,
      propose_issue: proposeIssue, assert_report_privacy: assertReportPrivacy, monotonic: () => 0,
    },
  });
  return {
    fixture, routine, service, runner, readPolicy, resolvePolicy, assertCurrent, readEvidence, proposeIssue, assertReportPrivacy,
    routinePath: routineStatePath(fixture.state), ledgerPath: budgetStatePath(fixture.state),
  };
}

type RoutineFixture = ReturnType<typeof setupRoutine>;

async function withRoutine(check: (setup: RoutineFixture) => void | Promise<void>) {
  const fixture = createRolePolicyFixture();
  let setup: RoutineFixture | undefined;
  try {
    for (const [name, value] of Object.entries(fixture.environment)) vi.stubEnv(name, value);
    const inventory = readdirSync(fixture.checkout, { recursive: true }).sort();
    const primerPath = join(fixture.checkout, "AGENTS.md");
    const primer = readFileSync(primerPath);
    setup = setupRoutine(fixture);
    await check(setup);
    expect(readdirSync(fixture.checkout, { recursive: true }).sort()).toEqual(inventory);
    expect(readFileSync(primerPath)).toEqual(primer);
  } finally {
    try {
      if (setup) {
        await setup.runner.stop();
        expect(setup.runner.activeCount).toBe(0);
      }
    } finally {
      vi.unstubAllEnvs();
      fixture.dispose();
    }
  }
}

function expectNoWriteEffects(setup: RoutineFixture) {
  expect(setup.proposeIssue).not.toHaveBeenCalled();
  expect(setup.assertReportPrivacy).not.toHaveBeenCalled();
  expect(existsSync(tasksDir(setup.fixture.state))).toBe(false);
  expect(existsSync(issueStatePath(setup.fixture.state))).toBe(false);
  expect(existsSync(join(setup.fixture.state, "reports"))).toBe(false);
}

async function expectDenialPreservesState(setup: RoutineFixture, attempt: () => void | Promise<void>) {
  const before = readFileSync(setup.routinePath);
  const inventory = readdirSync(setup.fixture.root, { recursive: true }).sort();
  await attempt();
  expect(readFileSync(setup.routinePath)).toEqual(before);
  expect(readdirSync(setup.fixture.root, { recursive: true }).sort()).toEqual(inventory);
  expect(existsSync(setup.ledgerPath)).toBe(false);
  expect(setup.runner.activeCount).toBe(0);
  for (const callback of [setup.readPolicy, setup.resolvePolicy, setup.assertCurrent, setup.readEvidence]) {
    expect(callback).not.toHaveBeenCalled();
  }
  expectNoWriteEffects(setup);
}

describe("org.routine.prohibited-action", () => {
  it("completes one exact revision of the allowed refresh action", async () => {
    await withRoutine(async (setup) => {
      const { routine, runner, routinePath, ledgerPath, readEvidence } = setup;
      runner.runManual(routine.id, routine.revision, workerId, 1);
      expect(runner.activeCount).toBe(1);
      await runner.idle();
      expect(runner.activeCount).toBe(0);
      expect(runner.lastFailure).toBeNull();
      expect(readEvidence).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ routine_id: routine.id, routine_revision: routine.revision, status: "running" }),
        expect.any(Object),
      );

      const saved = readRoutineDocument(routinePath);
      expect(saved?.routines[routine.id]).toEqual(routine);
      expect(Object.values(saved?.occurrences ?? {})).toMatchObject([{
        routine_id: routine.id, routine_revision: routine.revision, definition: routine, trigger: "manual",
        status: "completed", owner: { worker_id: workerId },
        receipt: {
          routine_id: routine.id, routine_revision: routine.revision, action: "refresh-evidence",
          freshness: "fresh", failure_code: null, budget_outcome: "within-limit", proposals: [],
          sources: [{ kind: "organization", state: "fresh", fingerprint: evidenceFingerprint }],
          counts: { facts_total: 1, facts_fresh: 1, proposals_created: 0, reports_written: 0 },
          consumption: { attempts: 1, runtime_state: "complete", model_calls: 0, total_tokens: 0, workspace_writes: 0 },
        },
      }]);
      const [occurrence] = Object.values(saved!.occurrences);
      const ledger = readBudgetLedger(ledgerPath);
      expect(Object.values(ledger?.charges ?? {})).toMatchObject([{ status: "terminal", attempts: 1, observed_total_tokens: 0 }]);
      expect(Object.values(ledger?.reservations ?? {})).toMatchObject([
        { id: occurrence!.budget.reservation_id, status: "settled" },
      ]);
      expectNoWriteEffects(setup);
    });
  });

  it.each([
    { name: "a prohibited publish action", change: { action: "publish" } },
    { name: "a caller-supplied command on an allowed action", change: { command: "synthetic-prohibited-command" } },
  ])("rejects $name before configuration or effects", async ({ change }) => {
    await withRoutine(async (setup) => {
      const { routine, service, routinePath } = setup;
      const before = readRoutineDocument(routinePath);
      expect(before?.occurrences).toEqual({});
      const input = { ...manualConfiguration(routine), ...change } as RoutineConfigureInput;
      await expectDenialPreservesState(setup, () => {
        throws(
          () => service.configure(routine.id, input),
          (error: unknown) => error instanceof RoutineServiceError && error.status === 400
            && error.message === "Invalid routine or budget input.",
        );
        expect(readRoutineDocument(routinePath)).toEqual(before);
      });
    });
  });

  it("denies a saved prohibited action before policy resolution or budget admission", async () => {
    await withRoutine(async (setup) => {
      const { routine, runner, routinePath } = setup;
      const baseline = readRoutineDocument(routinePath);
      if (!baseline) throw new Error("The prepared routine document is missing.");
      const revisionKey = routineRevisionKey(routine.id, routine.revision);
      expect(baseline.routines[routine.id]).toEqual(routine);
      expect(baseline.definitions[revisionKey]).toEqual(routine);
      expect(baseline.occurrences).toEqual({});
      const prohibited = { ...routine, action: "run-command" };
      const forged = {
        ...baseline,
        routines: { ...baseline.routines, [routine.id]: prohibited },
        definitions: { ...baseline.definitions, [revisionKey]: prohibited },
      };
      throws(
        () => assertRoutineDocument(forged),
        (error: unknown) => error instanceof RoutineContractError && error.message === "Invalid or unsupported routine document",
      );
      writeFileSync(routinePath, JSON.stringify(forged) + "\n");
      await expectDenialPreservesState(setup, async () => {
        throws(() => readRoutineDocument(routinePath), RoutineStateError);
        runner.runManual(routine.id, routine.revision, workerId, 1);
        await runner.idle();
        expect(runner.lastFailure).toBe("state-invalid");
      });
    });
  });
});
