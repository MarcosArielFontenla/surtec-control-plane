import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createHttpSecurity, isLoopbackHost } from "./http-security";

function appFor(token = "test-token"): Hono {
  const app = new Hono();
  const security = createHttpSecurity(token);
  app.use("/api/*", security.middleware);
  app.get("/api/read", (context) => context.json({ ok: true }));
  app.post("/api/write", (context) => context.json({ ok: true }));
  return app;
}

describe("HTTP security", () => {
  it("accepts only loopback hostnames", () => {
    expect(isLoopbackHost("localhost:4317")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:4317")).toBe(true);
    expect(isLoopbackHost("[::1]:4317")).toBe(true);
    expect(isLoopbackHost("control.example:4317")).toBe(false);
  });

  it("requires the session token for mutations", async () => {
    const app = appFor();
    expect((await app.request("http://127.0.0.1:4317/api/write", { method: "POST" })).status).toBe(403);
    expect((await app.request("http://127.0.0.1:4317/api/write", { method: "POST", headers: { "X-Surtec-Session": "wrong" } })).status).toBe(403);
    expect((await app.request("http://127.0.0.1:4317/api/write", { method: "POST", headers: { "X-Surtec-Session": "test-token" } })).status).toBe(200);
  });

  it("rejects hostile hosts and cross-origin mutations", async () => {
    const app = appFor();
    expect((await app.request("http://evil.example/api/read")).status).toBe(403);
    const response = await app.request("http://127.0.0.1:4317/api/write", {
      method: "POST",
      headers: { "X-Surtec-Session": "test-token", Origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });
});

