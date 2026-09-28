// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProjectProfile } from "../../../../lib/portfolio-profile";
import { getClients, saveProjectProfile } from "../api";
import { ProjectProfileEditor } from "./ProjectProfileEditor";

vi.mock("../api", () => ({ getClients: vi.fn(), saveProjectProfile: vi.fn() }));

const savedProfile: ProjectProfile = {
  schema_version: 1,
  project_id: "alpha",
  kind: "client",
  lifecycle: "active",
  priority: 2,
  criticality: "high",
  current_goal: "Ship release 2.",
  next_action: "Review acceptance criteria.",
  deadline: "2026-12-15",
  client_id: "client-demo",
  last_reviewed_at: "2026-09-27",
  tags: ["release", "priority"],
};

afterEach(() => vi.clearAllMocks());

describe("ProjectProfileEditor", () => {
  it("visually separates local profile context and summarizes a saved profile", () => {
    render(<ProjectProfileEditor projectId="alpha" profile={savedProfile} onSaved={vi.fn()} />);
    expect(screen.getByText("PERFIL OPERATIVO · LOCAL")).toBeTruthy();
    expect(screen.getByText(/Cliente · Activo · prioridad 2\/5 · criticidad Alta/)).toBeTruthy();
    expect(screen.getByText("Ship release 2.")).toBeTruthy();
    expect(screen.getByText(/Siguiente:/)).toBeTruthy();
  });

  it("edits all profile fields and saves only through the local profile API", async () => {
    const editedProfile = { ...savedProfile, lifecycle: "discovery" as const, priority: 1 };
    vi.mocked(saveProjectProfile).mockResolvedValue({ profile: editedProfile });
    vi.mocked(getClients).mockResolvedValue({ clients: [{
      id: "client-demo", display_name: "Fictional Client", status: "active", criticality: "high",
      project_ids: ["alpha"], next_review_date: null, active_commitment_count: 0,
    }] });
    const onSaved = vi.fn();
    render(<ProjectProfileEditor projectId="alpha" onSaved={onSaved} />);

    fireEvent.click(screen.getByRole("button", { name: /completar perfil/i }));
    expect(screen.getByText(/no modifica `registry\/projects\.yml` ni se incluye en Git/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Clasificación"), { target: { value: "client" } });
    fireEvent.change(screen.getByLabelText("Ciclo de vida"), { target: { value: "discovery" } });
    fireEvent.change(screen.getByLabelText(/Prioridad/), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Criticidad"), { target: { value: "high" } });
    await screen.findByRole("option", { name: /Fictional Client/ });
    fireEvent.change(screen.getByLabelText("Cliente asociado"), { target: { value: "client-demo" } });
    fireEvent.change(screen.getByLabelText("Objetivo actual"), { target: { value: "  Ship release 2.  " } });
    fireEvent.change(screen.getByLabelText("Próxima acción"), { target: { value: " Review acceptance criteria. " } });
    fireEvent.change(screen.getByLabelText("Fecha límite"), { target: { value: "2026-12-15" } });
    fireEvent.change(screen.getByLabelText("Última revisión"), { target: { value: "2026-09-27" } });
    fireEvent.change(screen.getByLabelText(/Etiquetas/), { target: { value: "release, priority, release" } });
    fireEvent.click(screen.getByRole("button", { name: /guardar perfil local/i }));

    await waitFor(() => expect(saveProjectProfile).toHaveBeenCalledTimes(1));
    expect(saveProjectProfile).toHaveBeenCalledWith(editedProfile);
    expect(onSaved).toHaveBeenCalledWith(editedProfile);
    expect(await screen.findByRole("status")).toHaveTextContent(/guardado solo en el estado local/i);
  });

  it("disables editing when the local store could not be read", () => {
    render(<ProjectProfileEditor projectId="alpha" ready={false} onSaved={vi.fn()} />);
    expect((screen.getByRole("button", { name: /perfil no disponible/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the form open and reports a save failure", async () => {
    vi.mocked(saveProjectProfile).mockRejectedValue(new Error("store unavailable"));
    render(<ProjectProfileEditor projectId="alpha" onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /completar perfil/i }));
    fireEvent.click(screen.getByRole("button", { name: /guardar perfil local/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("store unavailable");
    expect(screen.getByRole("button", { name: /guardar perfil local/i })).toBeTruthy();
  });
});
