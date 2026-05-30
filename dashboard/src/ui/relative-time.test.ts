import { describe, it, expect } from "vitest";
import { relativeTime } from "./relative-time";

const base = Date.parse("2026-05-29T12:00:00Z");
const ago = (ms: number) => new Date(base - ms).toISOString();

describe("relativeTime", () => {
  it("returns 'recién' under a minute", () => { expect(relativeTime(ago(30_000), base)).toBe("recién"); });
  it("returns minutes", () => { expect(relativeTime(ago(5 * 60_000), base)).toBe("Hace 5 min"); });
  it("returns hours", () => { expect(relativeTime(ago(3 * 3_600_000), base)).toBe("Hace 3 h"); });
  it("returns 'Ayer' between 24 and 48h", () => { expect(relativeTime(ago(30 * 3_600_000), base)).toBe("Ayer"); });
  it("returns days under a week", () => { expect(relativeTime(ago(4 * 86_400_000), base)).toBe("Hace 4 días"); });
  it("returns a short date beyond a week", () => { expect(relativeTime(ago(40 * 86_400_000), base)).toMatch(/^\d{1,2} (ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)$/); });
  it("returns '' for an invalid date", () => { expect(relativeTime("not-a-date", base)).toBe(""); });
});
