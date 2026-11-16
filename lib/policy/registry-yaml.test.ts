import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseRegistryYaml } from "./registry-yaml";

describe("registry YAML decoding", () => {
  it("returns detached data while preserving aliases within each decoded document", () => {
    const source = "roles: &roles [planner]\nactive: *roles\n";
    const parsed = parseRegistryYaml(source) as { roles: string[]; active: string[] };
    expect(parsed).toEqual(parse(source));
    expect(parsed.active).toBe(parsed.roles);

    parsed.roles.push("forged");
    const second = parseRegistryYaml(source) as (typeof parsed);
    expect(second).toEqual({ roles: ["planner"], active: ["planner"] });
    expect(second.active).toBe(second.roles);
    expect(second.roles).not.toBe(parsed.roles);
    second.roles.push("later mutation");

    expect(parseRegistryYaml(source)).toEqual(parse(source));
  });

  it("decodes same-length replacements independently and retains parse errors", () => {
    expect(parseRegistryYaml("role: reader\n")).toEqual({ role: "reader" });
    expect(parseRegistryYaml("role: writer\n")).toEqual({ role: "writer" });
    expect(() => parseRegistryYaml("role: [reader\n")).toThrow();
    expect(parseRegistryYaml("role: reader\n")).toEqual({ role: "reader" });
  });

  it("keeps the original parse behavior for large input", () => {
    const source = "description: " + "x".repeat(64 * 1024) + "\n";
    expect(parseRegistryYaml(source)).toEqual(parse(source));
  });
});
