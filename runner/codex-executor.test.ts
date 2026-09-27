import { describe, expect, it } from "vitest";
import { codexAppServerEnvironment } from "../lib/security/environment";

describe("codexAppServerEnvironment", () => {
  it("keeps runtime essentials and excludes unrelated inherited secrets", () => {
    const filtered = codexAppServerEnvironment({
      PATH: "bin",
      USERPROFILE: "C:\\Users\\test",
      OPENAI_API_KEY: "required-by-runtime",
      GH_TOKEN: "github-auth-fixture",
      RAILWAY_TOKEN: "railway-fixture",
      UNRELATED_SERVICE_SECRET: "must-not-cross-boundary",
    });

    expect(filtered).toEqual({
      PATH: "bin",
      USERPROFILE: "C:\\Users\\test",
      OPENAI_API_KEY: "required-by-runtime",
    });
  });
});
