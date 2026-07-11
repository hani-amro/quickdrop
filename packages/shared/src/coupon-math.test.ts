import { describe, expect, it } from "vitest";
import { computeCouponDiscount } from "./coupon-math.js";

// §8.3-4 v1.1 — منطق الخصم الصافي: النِسَب، المبلغ الثابت، التوصيل المجاني،
// وأهم قاعدة (8.3-4): الخصم لا يجعل السعر سالباً أبداً.
describe("computeCouponDiscount", () => {
  it("percent uses basis points (10% of 20,000 = 2,000)", () => {
    expect(computeCouponDiscount("percent", 1000n, 20000n)).toBe(2000n);
  });

  it("percent rounds down (integer division — الفخ 1)", () => {
    // 33% من 10,000 = 3,300؛ 3333 bp من 5,001 = 1666.99 → 1666
    expect(computeCouponDiscount("percent", 3333n, 5001n)).toBe(1666n);
  });

  it("percent above 100% is capped at the subtotal (never negative)", () => {
    expect(computeCouponDiscount("percent", 15000n, 10000n)).toBe(10000n);
  });

  it("fixed below subtotal is taken as-is", () => {
    expect(computeCouponDiscount("fixed", 3000n, 10000n)).toBe(3000n);
  });

  it("fixed at or above subtotal is clamped to subtotal (min(value, subtotal))", () => {
    expect(computeCouponDiscount("fixed", 12000n, 10000n)).toBe(10000n);
    expect(computeCouponDiscount("fixed", 10000n, 10000n)).toBe(10000n);
  });

  it("free_delivery waives the whole delivery fee", () => {
    expect(computeCouponDiscount("free_delivery", 0n, 8000n)).toBe(8000n);
  });

  it("never produces a discount greater than the subtotal (8.3-4)", () => {
    for (const kind of ["percent", "fixed", "free_delivery"] as const) {
      const d = computeCouponDiscount(kind, 999_999n, 7000n);
      expect(d).toBeLessThanOrEqual(7000n);
      expect(d).toBeGreaterThanOrEqual(0n);
    }
  });

  it("a zero subtotal yields a zero discount for every kind", () => {
    expect(computeCouponDiscount("percent", 5000n, 0n)).toBe(0n);
    expect(computeCouponDiscount("fixed", 5000n, 0n)).toBe(0n);
    expect(computeCouponDiscount("free_delivery", 5000n, 0n)).toBe(0n);
  });

  it("uses integer bigint math — no precision loss on large amounts", () => {
    // 50% من مبلغ يتجاوز Number.MAX_SAFE_INTEGER
    expect(computeCouponDiscount("percent", 5000n, 9_007_199_254_740_993n)).toBe(4_503_599_627_370_496n);
  });

  it("rejects negative value or subtotal", () => {
    expect(() => computeCouponDiscount("fixed", -1n, 1000n)).toThrow(RangeError);
    expect(() => computeCouponDiscount("percent", 1000n, -1n)).toThrow(RangeError);
  });
});
