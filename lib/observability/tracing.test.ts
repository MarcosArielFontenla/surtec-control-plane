import { describe, expect, it } from "vitest";
import { noOpTracer } from "./tracing";

describe("noOpTracer", () => {
  it("provides an optional tracing boundary without a runtime dependency", () => {
    const span = noOpTracer.startSpan("task.attempt", { task_id: "T-1" });

    expect(span.context).toBeNull();
    expect(() => {
      span.addEvent("started");
      span.end("ok");
    }).not.toThrow();
  });
});
