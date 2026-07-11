import { describe, expect, it } from "vitest";
import { PLAN_DRIVER_LIMITS, planAllowsDriverCount } from "./plans.js";

// §14 — سقوف الباقات ومنطق السماح بتفعيل سائق إضافي (منطق صافٍ).
describe("PLAN_DRIVER_LIMITS", () => {
  it("matches the §14 plan caps (starter 3, growth 10, pro unlimited)", () => {
    expect(PLAN_DRIVER_LIMITS.starter).toBe(3);
    expect(PLAN_DRIVER_LIMITS.growth).toBe(10);
    expect(PLAN_DRIVER_LIMITS.pro).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("planAllowsDriverCount", () => {
  it("allows activating up to — but not beyond — the starter cap (3)", () => {
    expect(planAllowsDriverCount("starter", 0)).toBe(true);
    expect(planAllowsDriverCount("starter", 2)).toBe(true); // 2 < 3 → يسمح بالسائق الثالث
    expect(planAllowsDriverCount("starter", 3)).toBe(false); // امتلأت الباقة
    expect(planAllowsDriverCount("starter", 4)).toBe(false); // فوق السقف (لو حدث بأثر تاريخي)
  });

  it("allows activating up to — but not beyond — the growth cap (10)", () => {
    expect(planAllowsDriverCount("growth", 9)).toBe(true);
    expect(planAllowsDriverCount("growth", 10)).toBe(false);
  });

  it("never caps pro (Infinity)", () => {
    expect(planAllowsDriverCount("pro", 0)).toBe(true);
    expect(planAllowsDriverCount("pro", 10_000)).toBe(true);
  });

  it("rejects an invalid current count — §16.12: no silent default", () => {
    expect(() => planAllowsDriverCount("starter", -1)).toThrow(RangeError);
    expect(() => planAllowsDriverCount("starter", 1.5)).toThrow(RangeError);
    expect(() => planAllowsDriverCount("starter", Number.NaN)).toThrow(RangeError);
  });
});
