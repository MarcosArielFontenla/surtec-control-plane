const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && !value.includes("..")
    && SAFE_IDENTIFIER.test(value);
}

export function assertSafeIdentifier(value: unknown, label = "identifier"): asserts value is string {
  if (!isSafeIdentifier(value)) throw new Error(`invalid ${label}`);
}

