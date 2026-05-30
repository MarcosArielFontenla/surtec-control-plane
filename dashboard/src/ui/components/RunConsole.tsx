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
  const dot = status === "running" ? "es-dot--info"
    : status === "exited" ? "es-dot--ok" : "es-dot--danger";

  return (
    <div className="es-console">
      <div className="es-console__bar">
        <span className={`es-dot ${dot}`} />
        <span className="es-console__status">{STATUS_LABEL[status]}</span>
        {record?.exitCode != null && <span className="es-num">exit {record.exitCode}</span>}
        {record && <span className="es-console__cmd">{record.command}</span>}
      </div>
      <pre className="es-console__log" ref={preRef}>{log}</pre>
    </div>
  );
}
