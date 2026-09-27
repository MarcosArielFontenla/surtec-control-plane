import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { withStateLock } from "./store";
import { locksDir, signalHumanStatePath } from "./paths";
import type { SignalAction, SignalHumanRecord, SignalHumanStateDocument, SignalState } from "../signals/types";
import { describeValidation, validateSignalHumanStateDocument } from "./validation";

const MAX_STATE_BYTES = 10 * 1024 * 1024;
const ID_PATTERN = /^sig_[a-f0-9]{24}$/;

export class SignalHumanStateError extends Error {}

export class UnsupportedSignalStateVersionError extends SignalHumanStateError {
  constructor(readonly version: number) {
    super(`unsupported signal state schema version: ${version}`);
  }
}

export class InvalidSignalActionError extends SignalHumanStateError {}

const emptyDocument = (): SignalHumanStateDocument => ({ schema_version: 1, records: {} });

function writeDocumentAtomic(filePath: string, document: SignalHumanStateDocument): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(document, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* only the unique temporary file created above is eligible for cleanup */ }
    throw error;
  }
}

function readDocument(filePath: string): SignalHumanStateDocument {
  if (!existsSync(filePath)) return emptyDocument();
  if (statSync(filePath).size > MAX_STATE_BYTES) throw new SignalHumanStateError("signal state store exceeds its size limit");

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new SignalHumanStateError("signal state store contains invalid JSON");
  }

  const version = value && typeof value === "object" ? (value as { schema_version?: unknown }).schema_version : undefined;
  if (typeof version === "number" && version > 1) throw new UnsupportedSignalStateVersionError(version);
  if (!validateSignalHumanStateDocument(value)) {
    throw new SignalHumanStateError(`signal state store is invalid: ${describeValidation(validateSignalHumanStateDocument.errors)}`);
  }
  return value;
}

export function readSignalHumanState(filePath: string = signalHumanStatePath()): SignalHumanStateDocument {
  return readDocument(filePath);
}

function localDate(now: Date): string {
  const year = now.getFullYear().toString().padStart(4, "0");
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultRecord(): SignalHumanRecord {
  return { state: "open", snoozed_until: null, pinned_for: null, dismissed: false, updated_at: new Date(0).toISOString() };
}

export function applySignalAction(
  signalId: string,
  action: SignalAction,
  options: { filePath?: string; now?: Date } = {},
): SignalHumanStateDocument {
  if (!ID_PATTERN.test(signalId)) throw new InvalidSignalActionError("invalid signal id");
  const now = options.now ?? new Date();
  const filePath = options.filePath ?? signalHumanStatePath();
  const stateRoot = dirname(dirname(filePath));
  return withStateLock("signals", () => {
    const document = readDocument(filePath);
    const record = { ...defaultRecord(), ...document.records[signalId] };
    if (action.action === "acknowledge") {
      record.state = "acknowledged";
      record.snoozed_until = null;
    } else if (action.action === "snooze") {
      const until = Date.parse(action.until);
      if (!Number.isFinite(until) || until <= now.getTime()) throw new InvalidSignalActionError("snooze time must be a valid future date/time");
      record.state = "snoozed";
      record.snoozed_until = new Date(until).toISOString();
    } else if (action.action === "pin-for-today") {
      record.pinned_for = localDate(now);
    } else if (action.action === "dismiss") {
      record.dismissed = true;
    } else if (action.action === "resolve") {
      record.state = "resolved";
      record.snoozed_until = null;
    }
    record.updated_at = now.toISOString();
    document.records[signalId] = record;
    if (!validateSignalHumanStateDocument(document)) {
      throw new SignalHumanStateError(`signal state is invalid: ${describeValidation(validateSignalHumanStateDocument.errors)}`);
    }
    writeDocumentAtomic(filePath, document);
    return document;
  }, locksDir(stateRoot));
}

export function projectSignalHumanState(
  signals: import("../signals/types").Signal[],
  document: SignalHumanStateDocument,
  now: Date,
): { signals: import("../signals/types").Signal[]; pinned_signal_ids: string[] } {
  const today = localDate(now);
  const visible: import("../signals/types").Signal[] = [];
  const pinned: string[] = [];
  for (const signal of signals) {
    const record = document.records[signal.id];
    if (record?.dismissed) continue;
    const expiredSnooze = record?.state === "snoozed" && record.snoozed_until !== null && Date.parse(record.snoozed_until) <= now.getTime();
    const state: SignalState = expiredSnooze ? "open" : record?.state ?? "open";
    const snoozedUntil = state === "snoozed" ? record?.snoozed_until ?? null : null;
    visible.push({ ...signal, state, snoozed_until: snoozedUntil });
    if (record?.pinned_for === today) pinned.push(signal.id);
  }
  const pinnedSet = new Set(pinned);
  visible.sort((left, right) => Number(pinnedSet.has(right.id)) - Number(pinnedSet.has(left.id))
    || left.ranking.order - right.ranking.order
    || (left.severity === "critical" ? 0 : left.severity === "warning" ? 1 : 2) - (right.severity === "critical" ? 0 : right.severity === "warning" ? 1 : 2)
    || left.evidence_at.localeCompare(right.evidence_at)
    || left.project_id.localeCompare(right.project_id)
    || left.id.localeCompare(right.id));
  pinned.sort();
  return { signals: visible, pinned_signal_ids: pinned };
}
