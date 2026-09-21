import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSafeIdentifier } from "./identifiers";
import { assertPathWithin, isPathWithin } from "./paths";
import { allowlistedEnvironment, gitEnvironment, projectCommandEnvironment } from "./environment";
import { redactText, safeJson } from "./redaction";

describe("security primitives", () => {
  it("accepts conservative identifiers and rejects traversal or separators", () => {
    expect(isSafeIdentifier("T-123_alpha.4")).toBe(true);
    expect(isSafeIdentifier("../task")).toBe(false);
    expect(isSafeIdentifier("a..b")).toBe(false);
    expect(isSafeIdentifier("a/b")).toBe(false);
    expect(isSafeIdentifier("-leading")).toBe(false);
  });

  it("checks canonical containment, including an existing symlink escape", () => {
    const root = mkdtempSync(join(tmpdir(), "surtec-path-root-"));
    const outside = mkdtempSync(join(tmpdir(), "surtec-path-outside-"));
    try {
      const child = join(root, "child");
      mkdirSync(child);
      expect(isPathWithin(root, child)).toBe(true);
      expect(isPathWithin(root, outside)).toBe(false);
      expect(() => assertPathWithin(root, join(root, "..", "escape"))).toThrow(/escapes/);
      const link = join(root, "link");
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      expect(isPathWithin(root, link)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("passes only explicit environment names", () => {
    const source = { PATH: "bin", SECRET: "no", GH_TOKEN: "ghp_123", APP_PORT: "1", SURTEC_RUN_ENV_ALLOWLIST: "APP_PORT" };
    expect(allowlistedEnvironment(source)).toEqual({ PATH: "bin" });
    expect(gitEnvironment(source)).toEqual({ PATH: "bin", GH_TOKEN: "ghp_123" });
    expect(projectCommandEnvironment(source)).toEqual({ PATH: "bin", APP_PORT: "1" });
  });

  it("redacts common tokens, assignments, URLs, and nested secret fields", () => {
    // secret-scan: allow -- synthetic credential used to verify redaction.
    const text = "api_key=abcdef ghp_abcdefghijklmnopqrstuvwxyz https://user:pass@example.test";
    expect(redactText(text)).not.toContain("abcdef");
    expect(redactText(text)).not.toContain(["ghp", "_abcdefghijklmnopqrstuvwxyz"].join(""));
    expect(redactText(text)).not.toContain("user:pass");
    const json = safeJson({ password: "hunter2", nested: { value: "Bearer: super-secret-value" } });
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("super-secret-value");
  });
});
