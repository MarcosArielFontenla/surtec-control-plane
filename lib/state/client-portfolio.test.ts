import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientCommitment, ClientRecord } from "../client-portfolio";
import { mutateClientPortfolio, readClientPortfolio, ClientPortfolioStoreError, UnsupportedClientPortfolioVersionError } from "./client-portfolio";
import { clientPortfolioPath } from "./paths";

let root: string | undefined;

function filePath(): string {
  root = mkdtempSync(join(tmpdir(), "surtec-client-portfolio-"));
  const path = clientPortfolioPath(join(root, "state"));
  mkdirSync(join(root, "state", "portfolio"), { recursive: true });
  return path;
}

const client: ClientRecord = {
  id: "client-example",
  display_name: "Fictional Example Client",
  status: "active",
  criticality: "high",
  sla_note: "Fictional response target.",
  next_review_date: "2026-10-15",
  confidential_notes: "Fictional note: never send without explicit selection.",
  created_at: "2026-09-28T12:00:00.000Z",
  updated_at: "2026-09-28T12:00:00.000Z",
};

const commitment: ClientCommitment = {
  id: "commitment-release",
  project_id: "fictional-project",
  client_id: "client-example",
  title: "Fictional release milestone",
  expected_outcome: "The fictional release is available to its users.",
  due_date: "2026-09-30",
  priority: 1,
  criticality: "high",
  state: "in-progress",
  issue_numbers: [12],
  pull_request_numbers: [34],
  task_ids: ["TASK-12"],
  session_ids: ["session-12"],
  next_action: "Verify the release checklist.",
  created_at: "2026-09-28T12:00:00.000Z",
  updated_at: "2026-09-28T12:00:00.000Z",
};

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("client portfolio persistence", () => {
  it("starts empty and atomically persists validated clients and commitments", () => {
    const path = filePath();
    expect(readClientPortfolio(path)).toEqual({ schema_version: 1, clients: {}, commitments: {} });
    mutateClientPortfolio((document) => {
      document.clients[client.id] = client;
      document.commitments[commitment.id] = commitment;
    }, path);

    expect(readClientPortfolio(path)).toMatchObject({
      schema_version: 1,
      clients: { [client.id]: client },
      commitments: { [commitment.id]: commitment },
    });
    expect(existsSync(path + ".tmp")).toBe(false);
  });

  it("rejects invalid writes before replacing prior state", () => {
    const path = filePath();
    mutateClientPortfolio((document) => { document.clients[client.id] = client; }, path);
    expect(() => mutateClientPortfolio((document) => {
      document.clients[client.id] = { ...client, display_name: "   " };
    }, path)).toThrow(ClientPortfolioStoreError);
    expect(readClientPortfolio(path).clients[client.id]).toEqual(client);
  });

  it("fails closed on malformed JSON and unsupported future versions without modifying bytes", () => {
    const path = filePath();
    const future = JSON.stringify({ schema_version: 2, clients: {}, commitments: {} });
    writeFileSync(path, future, "utf8");
    expect(() => readClientPortfolio(path)).toThrow(UnsupportedClientPortfolioVersionError);
    expect(() => mutateClientPortfolio((document) => { document.clients[client.id] = client; }, path)).toThrow(UnsupportedClientPortfolioVersionError);
    expect(readFileSync(path, "utf8")).toBe(future);

    writeFileSync(path, "{ invalid", "utf8");
    expect(() => readClientPortfolio(path)).toThrow(/invalid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{ invalid");
  });

  it("rejects oversized local documents before parsing or writing", () => {
    const path = filePath();
    const oversized = "{\"schema_version\":1,\"clients\":{},\"commitments\":{},\"padding\":\"" + "x".repeat(10 * 1024 * 1024) + "\"}";
    writeFileSync(path, oversized, "utf8");
    expect(() => readClientPortfolio(path)).toThrow(/10 MiB limit/);
    expect(() => mutateClientPortfolio(() => {}, path)).toThrow(/10 MiB limit/);
    expect(readFileSync(path, "utf8")).toBe(oversized);
  });
});
