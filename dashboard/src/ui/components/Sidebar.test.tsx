// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sidebar } from "./Sidebar";

const summary = { total: 14, configured: 12, unconfigured: 2, attention: 3 };

describe("Sidebar", () => {
  it("renders brand, nav items and the derived Resumen", () => {
    render(<Sidebar active="Overview" onSelect={() => {}} summary={summary} connected />);
    expect(screen.getByText("Surtec")).toBeInTheDocument();
    for (const item of ["Hoy", "Overview", "Procesos", "Issues", "Actividad"]) {
      expect(screen.getByRole("button", { name: new RegExp(item) })).toBeInTheDocument();
    }
    expect(screen.getByText("14")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("fires onSelect with the clicked nav item", () => {
    const onSelect = vi.fn();
    render(<Sidebar active="Overview" onSelect={onSelect} summary={summary} connected />);
    fireEvent.click(screen.getByRole("button", { name: /Procesos/ }));
    expect(onSelect).toHaveBeenCalledWith("Procesos");
  });
});
