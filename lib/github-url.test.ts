import { describe, it, expect } from "vitest";
import { githubWebUrl } from "./github-url";

describe("githubWebUrl", () => {
  it("converts an https remote with .git", () => {
    expect(githubWebUrl("https://github.com/MarcosArielFontenla/appointment-manager.git"))
      .toBe("https://github.com/MarcosArielFontenla/appointment-manager");
  });
  it("keeps an https remote without .git", () => {
    expect(githubWebUrl("https://github.com/owner/repo")).toBe("https://github.com/owner/repo");
  });
  it("converts an ssh git@ remote", () => {
    expect(githubWebUrl("git@github.com:owner/repo.git")).toBe("https://github.com/owner/repo");
  });
  it("converts an ssh:// remote", () => {
    expect(githubWebUrl("ssh://git@github.com/owner/repo.git")).toBe("https://github.com/owner/repo");
  });
  it("strips a trailing slash", () => {
    expect(githubWebUrl("https://github.com/owner/repo/")).toBe("https://github.com/owner/repo");
  });
  it("returns null for a non-GitHub host", () => {
    expect(githubWebUrl("git@gitlab.com:owner/repo.git")).toBeNull();
  });
  it("returns null for null/empty", () => {
    expect(githubWebUrl(null)).toBeNull();
    expect(githubWebUrl("")).toBeNull();
  });
  it("normalizes an http:// remote to https", () => {
    expect(githubWebUrl("http://github.com/owner/repo.git")).toBe("https://github.com/owner/repo");
  });
});
