import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    globals: true,
    setupFiles: ["@testing-library/jest-dom/vitest"],
    // Keep suite contention bounded so short async tests remain reliable on Windows hosts.
    maxWorkers: 2,
  },
});
