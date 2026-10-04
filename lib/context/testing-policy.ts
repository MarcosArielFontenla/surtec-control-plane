import type { ContextConfig, EffectiveTestingPolicy, ReviewDepth, TestingConstraint, TestingPlan } from "./types";
import { ContextContractError } from "./validation";

const own = <T>(record: Record<string, T>, id: string | undefined): T | undefined => id && Object.hasOwn(record, id) ? record[id] : undefined;
export function resolveTestingPolicy(config: ContextConfig, input: {
  projectId: string; roleId: string; issueId?: string; archetype?: string;
  verifyCommands: string[]; minimumReview?: ReviewDepth; harnessPolicy?: TestingConstraint;
}): EffectiveTestingPolicy {
  const layers = [
    { name: "global", policy: config.testing.global },
    { name: "archetype", policy: own(config.testing.archetypes, input.archetype) },
    { name: "project", policy: own(config.testing.projects, input.projectId) },
    { name: "issue", policy: own(config.testing.issues, input.issueId) },
    { name: "role", policy: own(config.testing.roles, input.roleId) },
    { name: "harness", policy: input.harnessPolicy },
  ].filter((layer): layer is { name: string; policy: TestingConstraint } => !!layer.policy);
  const mode = layers.some((layer) => layer.policy.mode === "strict-tdd") ? "strict-tdd" : "functional";
  const runnerIds = [...new Set(layers.flatMap((layer) => layer.policy.runner_ids))].sort();
  const runners = runnerIds.map((id) => {
    const runner = own(config.runners, id);
    if (!runner || !input.verifyCommands.includes(runner.command)) throw new ContextContractError("Testing runner is not currently authorized by project policy");
    return runner;
  });
  if (mode === "strict-tdd" && (!runners.some((runner) => runner.stage === "red") || !runners.some((runner) => runner.stage === "green"))) {
    throw new ContextContractError("Strict TDD requires trusted authorized RED and GREEN runners");
  }
  const resolved: EffectiveTestingPolicy = {
    mode,
    minimum_review_depth: input.minimumReview === "full" || layers.some((layer) => layer.policy.minimum_review_depth === "full") ? "full" : "focused",
    runner_ids: runnerIds,
    commands: [...new Set(mode === "functional" ? [...input.verifyCommands, ...runners.map((runner) => runner.command)] : runners.map((runner) => runner.command))],
    requires_red_evidence: mode === "strict-tdd",
    reasons: layers.map((layer) => `${layer.name}: ${layer.policy.mode}, ${layer.policy.minimum_review_depth} review; restrictive requirements retained`),
  };
  resolveTestingPlan(config, resolved);
  return resolved;
}

export function resolveTestingPlan(config: ContextConfig, policy: EffectiveTestingPolicy): TestingPlan {
  if (policy.mode === "functional") return { mode: "functional", runners: policy.commands.map((command) => ({ command, stage: "functional" })) };
  const runners = policy.runner_ids.map((id) => config.runners[id]!);
  const red = runners.filter((runner) => runner.stage === "red");
  const green = runners.filter((runner) => runner.stage === "green");
  if (!red.length || !green.length || [...red, ...green].some((runner) => !runner.probe)) throw new ContextContractError("Strict TDD requires observable pinned assertion probes");
  const identity = (runner: typeof runners[number]) => JSON.stringify({ sources: runner.probe!.sources, ids: [...runner.probe!.assertion_ids].sort() });
  if (new Set(red.map(identity)).size !== red.length || JSON.stringify(red.map(identity).sort()) !== JSON.stringify(green.map(identity).sort())) throw new ContextContractError("RED and GREEN must observe the same distinct pinned assertion identities");
  if (!runners.some((runner) => runner.stage === "refactor") && !config.testing.no_refactor_justification?.trim()) throw new ContextContractError("Strict TDD requires REFACTOR checks or an explicit trusted no-refactor justification");
  return { mode: "strict-tdd", runners, ...(config.testing.no_refactor_justification ? { noRefactorJustification: config.testing.no_refactor_justification } : {}) };
}
