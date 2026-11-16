import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkHistoricalNative, inspectHistoricalDecision, readHistoricalEvidence } from "./historical-adoption";
import { digest } from "./sealed-adoption";

const identity = { commit: "a".repeat(40), tree: "b".repeat(40), sealSha: digest("seal"), reportSha: digest("report") };
const candidate = { commit: identity.commit, tree: identity.tree };
const decision = () => ({
  status: "ACCEPTED_LOCALLY", project: "Gear List", canonical_g3_created: false,
  candidate, phases: { F3: "closed", F5: "closed" }, integration: { status: "not_performed", f4_n11: "not_applicable" },
  recorded_at_utc: "2026-11-13T00:35:19.614Z",
  evidence: { dossier: { sha256: identity.sealSha }, verification_report_sha256: identity.reportSha,
    reviewer: { decision: "approved" }, qa: { technical_verdict: "favorable", owner_decision: "confirmed" } },
  criteria: Array.from({ length: 8 }, (_, i) => ({ id: "F3-0" + (i + 1), decision: "accepted" })),
});
const reviewer = () => ({ decision: "approved", observations: [] as string[], candidate,
  evidence: { dossier_seal: { sha256: identity.sealSha }, verification_report_sha256: identity.reportSha } });

describe("historical human adoption evidence", () => {
  it("uses the original timestamp, criteria and closure instead of creating a new decision", () => {
    const accepted = decision();
    expect(inspectHistoricalDecision(accepted, reviewer(), identity))
      .toEqual({ status: accepted.status, recorded_at_utc: accepted.recorded_at_utc, criteria: accepted.criteria,
        phases: accepted.phases, integration: accepted.integration });
  });

  it.each([
    ["HISTORICAL_CRITERIA_MISMATCH", (data: ReturnType<typeof decision>, _review: ReturnType<typeof reviewer>) => {
      data.criteria[2]!.id = data.criteria[1]!.id;
    }],
    ["HISTORICAL_REVIEW_MISMATCH", (_data: ReturnType<typeof decision>, review: ReturnType<typeof reviewer>) => {
      review.evidence.verification_report_sha256 = digest("another report");
    }],
    ["HISTORICAL_REVIEW_MISMATCH", (data: ReturnType<typeof decision>, _review: ReturnType<typeof reviewer>) => {
      data.evidence.qa.owner_decision = "pending";
    }],
    ["HISTORICAL_ACCEPTANCE_MISMATCH", (data: ReturnType<typeof decision>, _review: ReturnType<typeof reviewer>) => {
      data.evidence.dossier.sha256 = digest("another dossier");
    }],
  ] as const)("rejects cross-bound historical evidence with %s", (code, mutate) => {
    const data = decision(), review = reviewer();
    mutate(data, review);
    expect(() => inspectHistoricalDecision(data, review, identity)).toThrow(code);
  });

  it("requires unforced native success and both drained streams", () => {
    const native = { native_exit: 0, native_signal: null, root_exit_observed: true, stdout_eof: true, stderr_eof: true,
      timed_out: false, capture_truncated: false, termination_requested: false, spawn_error: null, stream_error: null };
    expect(() => checkHistoricalNative(native)).not.toThrow();
    expect(() => checkHistoricalNative({ ...native, stderr_eof: false })).toThrow("HISTORICAL_VERIFICATION_INCOMPLETE");
    expect(() => checkHistoricalNative({ ...native, termination_requested: true })).toThrow("HISTORICAL_VERIFICATION_INCOMPLETE");
  });

  it("rejects one whitespace byte changed in the acceptance or in the original seal", () => {
    const temp = tmpdir(), root = mkdtempSync(join(temp, "surtec-historical-anchors-"));
    try {
      const location = join(root, "tmp", "f3-fix");
      mkdirSync(location, { recursive: true });
      const seal = '{"schema_version":1}\n', acceptance = '{"schema_version":1}\n';
      const profile = { id: "gear-list-f5" as const, sealSha: digest(seal), acceptanceSha: digest(acceptance) };
      writeFileSync(join(location, "seal.json"), seal.replace("\n", " "));
      writeFileSync(join(location, "local-acceptance.json"), acceptance);
      expect(() => readHistoricalEvidence(root, profile)).toThrow("HISTORICAL_SEAL_SHA256_MISMATCH");
      writeFileSync(join(location, "seal.json"), seal);
      writeFileSync(join(location, "local-acceptance.json"), acceptance.replace("\n", " "));
      expect(() => readHistoricalEvidence(root, profile)).toThrow("HISTORICAL_ACCEPTANCE_SHA256_MISMATCH");
    } finally {
      if (dirname(root) === temp) rmSync(root, { recursive: true, force: true });
    }
  });
});
