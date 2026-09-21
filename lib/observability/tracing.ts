export interface TraceContext {
  traceId: string;
  spanId: string;
}

export interface TraceSpan {
  readonly context: TraceContext | null;
  addEvent(name: string, attributes?: Record<string, string | number | boolean | null>): void;
  end(status?: "ok" | "error"): void;
}

export interface Tracer {
  startSpan(name: string, attributes?: Record<string, string | number | boolean | null>): TraceSpan;
}

const noOpSpan: TraceSpan = {
  context: null,
  addEvent: () => {},
  end: () => {},
};

export const noOpTracer: Tracer = {
  startSpan: () => noOpSpan,
};
