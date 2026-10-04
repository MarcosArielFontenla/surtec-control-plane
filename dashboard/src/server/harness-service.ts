import { PolicyService, PolicyError } from "../../../lib/policy/service";
import { loadHarnessSource } from "../../../lib/harness/source";
import { inspectHarness } from "../../../lib/harness/inspect";
import type { HarnessSource, ProjectHarnessProfile } from "../../../lib/harness/types";
import { readHarnessProfiles, saveHarnessProfile } from "../../../lib/state/harness-profiles";
import { harnessProfilesPath } from "../../../lib/state/paths";

export interface HarnessService {
  read(projectId: string): { observation: ProjectHarnessProfile; saved: ProjectHarnessProfile | null };
  refresh(projectId: string): { observation: ProjectHarnessProfile; saved: ProjectHarnessProfile };
}
export function createHarnessService(repoRoot: string, dependencies: {
  policy?: Pick<PolicyService, "project">;
  source?: () => HarnessSource;
  clock?: () => Date;
  statePath?: string;
} = {}): HarnessService {
  const policy = dependencies.policy ?? new PolicyService(repoRoot);
  const source = dependencies.source ?? (() => loadHarnessSource(repoRoot));
  const clock = dependencies.clock ?? (() => new Date());
  const path = dependencies.statePath ?? harnessProfilesPath();
  const observe = (projectId: string) => {
    const project = policy.project(projectId);
    if (!project.repo_path) throw new PolicyError("Local project checkout is unavailable", "not-found");
    return inspectHarness(project.repo_path, project.id, source(), clock());
  };
  return {
    read(projectId) {
      const observation = observe(projectId);
      const profiles = readHarnessProfiles(path).profiles;
      const saved = Object.hasOwn(profiles, projectId) ? profiles[projectId] : null;
      return { observation, saved };
    },
    refresh(projectId) {
      const observation = observe(projectId);
      saveHarnessProfile(observation, path);
      return { observation, saved: observation };
    },
  };
}
