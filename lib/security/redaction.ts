const SECRET_ASSIGNMENT = /\b(authorization|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*([^\s,;]+)/gi;
const TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
];

export function redactText(value: string): string {
  let redacted = value.replace(SECRET_ASSIGNMENT, "$1=[REDACTED]");
  for (const pattern of TOKEN_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]");
  return redacted.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

export function safeJson(value: unknown): string {
  const secretKey = /(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)/i;
  return redactText(JSON.stringify(value, (key, item) => {
    if (key && secretKey.test(key)) return "[REDACTED]";
    return typeof item === "string" ? redactText(item) : item;
  }));
}
