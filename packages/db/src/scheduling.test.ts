import { describe, expect, it } from "vitest";
import { scheduledDelayMs } from "./scheduling.js";

describe("scheduledDelayMs (§6.3)", () => {
  const now = new Date("2026-07-17T12:00:00Z");

  it("future schedule → positive delay to that moment", () => {
    expect(scheduledDelayMs(new Date("2026-07-17T12:30:00Z"), now)).toBe(30 * 60 * 1000);
  });

  it("past-due schedule → 0 (fire immediately), never negative", () => {
    expect(scheduledDelayMs(new Date("2026-07-17T11:00:00Z"), now)).toBe(0);
  });

  it("exactly now → 0", () => {
    expect(scheduledDelayMs(now, now)).toBe(0);
  });
});
