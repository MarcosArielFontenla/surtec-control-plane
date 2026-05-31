import { useEffect, useRef, useState } from "react";
import type { RunRecord } from "../../../../lib/state/types";
import { streamRun } from "../api";

const STATUS_LABEL: Record<RunRecord["status"], string> = {
  running: "corriendo", exited: "exited (ok)", failed: "failed", stopped: "stopped",
};

export function RunConsole({ runId }: { runId: string }) {
  const [log, setLog] = useState("");
  const [record, setRecord] = useState<RunRecord | null>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setLog("");
    setRecord(null);
    const close = streamRun(runId, {
      snapshot: (s) => { setLog(s.log); setRecord(s.record); },
      chunk: (d) => setLog((prev) => prev + d),
      status: (r) => setRecord(r),
    });
    return close;
  }, [runId]);

  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const status = record?.status ?? "running";
  const dot = status === "running" ? "info"
    : status === "exited" ? "ok" : "danger";

  return (
    <div className="console">
      <div className="console-bar">
        <span className={`pdot pdot--${dot}`} />
        <span className="console-status">{STATUS_LABEL[status]}</span>
        {record?.exitCode != null && <span className="console-exit">exit {record.exitCode}</span>}
        {record && <span className="console-cmd">{record.command}</span>}
      </div>
      <pre className="console-log" ref={preRef}>{log}</pre>
    </div>
  );
}
