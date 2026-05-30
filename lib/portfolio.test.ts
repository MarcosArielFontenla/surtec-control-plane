import { describe, it, expect } from "vitest";
import { assemblePortfolio, type ProjectConfig } from "./portfolio";
import type { DiscoveredProject } from "./discover";
import type { GitStatus } from "./state/types";

const gs = (branch: string): GitStatus => ({
  branch, dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true,
});
const discovered: DiscoveredProject[] = [
  { id: "alpha", path: "/p/alpha" },
  { id: "beta", path: "/p/beta" },
];
const statusByPath = new Map<string, GitStatus>([["/p/alpha", gs("main")], ["/p/beta", gs("dev")]]);

describe("assemblePortfolio", () => {
  it("marks a discovered project with config as configured and overlays its config", () => {
    const config = new Map<string, ProjectConfig>([
      ["alpha", { id: "alpha", status: "active", repo: "git@x:alpha.git", allowed_agents: ["backend-engineer"] }],
    ]);
    const out = assemblePortfolio(discovered, statusByPath, config);
    const alpha = out.find((p) => p.id === "alpha")!;
    expect(alpha.configured).toBe(true);
    expect(alpha.status).toBe("active");
    expect(alpha.repo).toBe("git@x:alpha.git");
    expect(alpha.path).toBe("/p/alpha");
    expect(alpha.git?.branch).toBe("main");
  });
  it("shows a discovered project without config as discovered + not configured", () => {
    const out = assemblePortfolio(discovered, statusByPath, new Map());
    const beta = out.find((p) => p.id === "beta")!;
    expect(beta.configured).toBe(false);
    expect(beta.status).toBe("discovered");
    expect(beta.repo).toBeNull();
    expect(beta.git?.branch).toBe("dev");
  });
  it("drops config entries with no discovered folder", () => {
    const config = new Map<string, ProjectConfig>([["ghost", { id: "ghost", status: "active", allowed_agents: ["x"] }]]);
    const out = assemblePortfolio(discovered, statusByPath, config);
    expect(out.map((p) => p.id)).toEqual(["alpha", "beta"]);
  });
  it("treats an empty allowed_agents as not configured", () => {
    const config = new Map<string, ProjectConfig>([["alpha", { id: "alpha", allowed_agents: [] }]]);
    expect(assemblePortfolio(discovered, statusByPath, config).find((p) => p.id === "alpha")!.configured).toBe(false);
  });
});
