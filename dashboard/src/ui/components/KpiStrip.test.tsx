// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { KpiStrip } from "./KpiStrip";
import type { Kpis } from "../derive-kpis";

const kpis: Kpis = {
  projects: { value: "14", foot: "12 activos · 2 descubiertos" },
  inProgress: { value: "0", foot: "sin tareas corriendo" },
  attention: { value: "3", foot: "1 aprobar · 1 riesgo · 1 bloqueo", emphasis: "ember" },
  uncommitted: { value: "2400", foot: "en 4 repos", emphasis: "aurora" },
};

describe("KpiStrip", () => {
  it("renders the four KPI labels, values and foots", () => {
    render(<KpiStrip kpis={kpis} />);
    for (const label of ["Proyectos", "En curso", "Atención", "Sin commitear"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("14")).toBeInTheDocument();
    expect(screen.getByText("1 aprobar · 1 riesgo · 1 bloqueo")).toBeInTheDocument();
    expect(screen.getByText("en 4 repos")).toBeInTheDocument();
  });
});
