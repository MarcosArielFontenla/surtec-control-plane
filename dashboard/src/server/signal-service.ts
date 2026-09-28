import { redactText } from "../../../lib/security/redaction";
import { applySignalAction, projectSignalHumanState, readSignalHumanState } from "../../../lib/state/signals";
import { signalHumanStatePath } from "../../../lib/state/paths";
import { generateSignals, type SignalEvidenceSnapshot } from "../../../lib/signals/engine";
import type { Signal, SignalAction, SignalFeed } from "../../../lib/signals/types";
import { describeValidation, validateSignalFeed } from "../../../lib/state/validation";
import type { SignalEvidenceReader } from "./signal-evidence";

export interface SignalService {
  read(): Promise<SignalFeed>;
  act(signalId: string, action: SignalAction): Promise<SignalFeed>;
}

export class SignalNotFoundError extends Error {}

export interface SignalServiceDependencies {
  reader: SignalEvidenceReader | { read(): Promise<SignalEvidenceSnapshot> };
  statePath?: string;
  clock?: () => Date;
}

function safeWarnings(values: string[]): string[] {
  return [...new Set(values.map((value) => redactText(value).replace(/[\r\n\t]+/g, " ").slice(0, 240)))].sort().slice(0, 50);
}

export function createSignalService(dependencies: SignalServiceDependencies): SignalService {
  const statePath = dependencies.statePath ?? signalHumanStatePath();
  const clock = dependencies.clock ?? (() => new Date());

  const buildFeed = async (): Promise<{ now: Date; signals: Signal[]; warnings: string[] }> => {
    const now = clock();
    const evidence = await dependencies.reader.read();
    const signals = generateSignals(evidence, now);
    return {
      now,
      signals,
      warnings: safeWarnings([
        ...(evidence.warnings ?? []),
        ...(signals.length === 5000 ? ["Signal feed reached its 5,000-item limit; lower-ranked signals may be omitted."] : []),
      ]),
    };
  };

  const projectFeed = (now: Date, signals: Signal[], warnings: string[]): SignalFeed => {
    const humanState = readSignalHumanState(statePath);
    const projected = projectSignalHumanState(signals, humanState, now);
    const feed: SignalFeed = {
      schema_version: 1,
      observed_at: now.toISOString(),
      signals: projected.signals,
      pinned_signal_ids: projected.pinned_signal_ids,
      warnings,
    };
    if (!validateSignalFeed(feed)) throw new Error(`generated signal feed is invalid: ${describeValidation(validateSignalFeed.errors)}`);
    return feed;
  };

  return {
    async read(): Promise<SignalFeed> {
      const { now, signals, warnings } = await buildFeed();
      return projectFeed(now, signals, warnings);
    },
    async act(signalId: string, action: SignalAction): Promise<SignalFeed> {
      const { now, signals, warnings } = await buildFeed();
      if (!signals.some((signal) => signal.id === signalId)) throw new SignalNotFoundError("signal is no longer present");
      if (readSignalHumanState(statePath).records[signalId]?.dismissed) throw new SignalNotFoundError("signal is no longer present");
      applySignalAction(signalId, action, { filePath: statePath, now, evidenceAt: signals.find((signal) => signal.id === signalId)?.evidence_at });
      return projectFeed(now, signals, warnings);
    },
  };
}
