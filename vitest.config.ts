import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { historicalProfilerAdapter } from "./scripts/testing/profile-maintenance-compat";

const integrationSuites = [
  "/runner/workflow-orchestrator.test.ts",
  "/runner/workflow-orchestrator-recovery.test.ts",
  "/runner/run-task.test.ts",
  "/dashboard/src/server/workflow-service.test.ts",
];

class IntegrationFirstSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const ordered = await super.sort(files);
    const integrations: TestSpecification[] = [];
    // A focused run can cache a small duration for an expensive integration file.
    // Schedule these long files early and keep the default order of other files.
    for (const path of integrationSuites) {
      const index = ordered.findIndex((file) => file.moduleId.replaceAll("\\", "/").endsWith(path));
      if (index >= 0) integrations.push(...ordered.splice(index, 1));
    }
    return [...integrations, ...ordered];
  }
}

const ciTimingReporter = process.env.SURTEC_CI_VITEST_TIMING_DIR
  ? fileURLToPath(new URL("./scripts/diagnostics/ci-vitest-timing.ts", import.meta.url))
  : undefined;

export default defineConfig({
  plugins: [historicalProfilerAdapter(fileURLToPath(new URL("./scripts/profile-maintenance.test.ts", import.meta.url)))],
  test: {
    ...(ciTimingReporter ? { reporters: ["default", ciTimingReporter] } : {}),
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    // The ignored pilot and diagnostics directory can contain checkout copies.
    exclude: [...configDefaults.exclude, "tmp/**"],
    globals: true,
    setupFiles: ["./dashboard/src/ui/test-setup.ts"],
    // Keep suite contention bounded so short async tests remain reliable on Windows hosts.
    maxWorkers: 2,
    sequence: { sequencer: IntegrationFirstSequencer },
  },
});
