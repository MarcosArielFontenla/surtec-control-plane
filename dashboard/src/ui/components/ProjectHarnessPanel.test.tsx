// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProjectHarnessProfile } from "../../../../lib/harness/types";
import { getProjectHarness } from "../api";
import { ProjectHarnessPanel } from "./ProjectHarnessPanel";
vi.mock("../api", () => ({ getProjectHarness: vi.fn() }));
const profile: ProjectHarnessProfile = {
  schema_version: 1, project_id: "alpha", status: "absent", detected_version: null, canonical_version: null, comparison: "unknown", capability_results: [], drift_summary: [], observed_at: "2026-09-30T02:00:00.000Z", source_fingerprint: null, project_fingerprint: "a".repeat(64), doctor_status: "unknown", findings: [], entries: [], testing_policy: { schema_version: 1, mode: "functional", runner_id: null, requires_red_evidence: false, applicable_task_kinds: [] }, runner_command: null, review_policy: "unknown", backup_ready: false, rollback_ready: false, validation: { status: "unknown", observed_at: null },
};
afterEach(() => vi.resetAllMocks());
describe("ProjectHarnessPanel", () => {
  it("reads without saving, then refreshes explicitly", async () => {
    vi.mocked(getProjectHarness).mockResolvedValueOnce({ observation: profile, saved: null }).mockResolvedValueOnce({ observation: profile, saved: profile });
    render(<ProjectHarnessPanel projectId="alpha" />); await screen.findByText("absent"); expect(getProjectHarness).toHaveBeenCalledWith("alpha");
    fireEvent.click(screen.getByRole("button", { name: "Actualizar Harness" })); await waitFor(() => expect(getProjectHarness).toHaveBeenCalledWith("alpha", true)); expect(await screen.findByText(/Última observación guardada:/)).toBeInTheDocument();
  });
  it("preserves evidence and reports failed refresh without implying project writes", async () => { vi.mocked(getProjectHarness).mockResolvedValueOnce({ observation: profile, saved: null }).mockRejectedValueOnce(new Error("failed")); render(<ProjectHarnessPanel projectId="alpha" />); await screen.findByText("absent"); fireEvent.click(screen.getByRole("button", { name: "Actualizar Harness" })); expect(await screen.findByRole("alert")).toHaveTextContent("no se modificó el proyecto"); expect(screen.getByText("absent")).toBeInTheDocument(); });
});
