// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectCard } from "./ProjectCard";
import type { ProjectView } from "../../../../lib/state/types";

const base: ProjectView = {
  id: "alpha", status: "active", health: null, note: null, repo: null,
  last_activity: null, task_counts: { inProgress: 0, finished: 0 },
  path: "/p/alpha", configured: true, git: null,
};

describe("ProjectCard git status", () => {
  it("renders git status, last commit and the configured chip", () => {
    const p: ProjectView = {
      ...base,
      git: { branch: "main", dirty: true, uncommitted: 2, ahead: 1, behind: 0,
        last_commit: { hash: "abc123", subject: "fix bug", at: "2026-05-29T10:00:00Z" }, ok: true },
    };
    render(<ProjectCard p={p} />);
    expect(screen.getByText(/main/)).toBeTruthy();
    expect(screen.getByText(/2 sin commitear/)).toBeTruthy();
    expect(screen.getByText(/fix bug/)).toBeTruthy();
    expect(screen.getByText(/configurado/i)).toBeTruthy();
  });

  it("shows 'limpio' for a clean repo and the sin-configurar chip", () => {
    const p: ProjectView = {
      ...base, configured: false,
      git: { branch: "dev", dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true },
    };
    render(<ProjectCard p={p} />);
    expect(screen.getByText(/limpio/i)).toBeTruthy();
    expect(screen.getByText(/sin configurar/i)).toBeTruthy();
  });

  it("shows 'no disponible' when git read failed", () => {
    const p: ProjectView = {
      ...base,
      git: { branch: null, dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: false },
    };
    render(<ProjectCard p={p} />);
    expect(screen.getByText(/no disponible/i)).toBeTruthy();
  });

  it("renders no git line when git is null", () => {
    render(<ProjectCard p={base} />);
    expect(screen.queryByText(/no disponible/i)).toBeNull();
    expect(screen.queryByText(/limpio/i)).toBeNull();
  });
});
