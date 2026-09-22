import { redactText } from "../security/redaction";

const MAX_ERROR_CHARS = 500;

export function integrationError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? "integration unavailable");
  return redactText(message.trim() || "integration unavailable").slice(0, MAX_ERROR_CHARS);
}

export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
