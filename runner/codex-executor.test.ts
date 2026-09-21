import { describe, expect, it } from "vitest";
import { appServerEnvironment } from "./codex-executor";

describe("appServerEnvironment", () => {
  it("keeps runtime essentials and excludes unrelated inherited secrets", () => {
    const filtered = appServerEnvironment({
      PATH: "bin",
      USERPROFILE: "C:\\Users\\test",
      OPENAI_API_KEY: "required-by-runtime",
      UNRELATED_SERVICE_SECRET: "must-not-cross-boundary",
    });

    expect(filtered).toEqual({
      PATH: "bin",
      USERPROFILE: "C:\\Users\\test",
      OPENAI_API_KEY: "required-by-runtime",
    });
  });
});
