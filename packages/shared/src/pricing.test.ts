import { describe, expect, it } from "vitest";
import { ROAD_DISTANCE_FALLBACK_FACTOR, haversineMeters, makePoint } from "./geo.js";
import { computePrice, type PriceComponents, type PricingRuleLike } from "./pricing.js";

// §8.3-1 — اختبار لكل invariant حسابي؛ D5 والفخ 1: bigint صرف بلا أي مرور على Number.

const rule = (over: Partial<PricingRuleLike> = {}): PricingRuleLike => ({
  base: 0n,
  perKm: 0n,
  perKg: 0n,
  minTotal: 0n,
  surgeMultiplierBp: 10000,
  ...over,
});

/** §8.3-1: المعادلة الكاملة يجب أن تتوازن دائماً مهما كانت المدخلات. */
const expectBalanced = (c: PriceComponents): void => {
  expect(c.total).toBe(c.base + c.distance + c.weight + c.surge + c.minAdjustment - c.discount);
};

describe("computePrice", () => {
  it("3500م × perKm=1000 → مكوّن مسافة 3500 (قسمة أعداد صحيحة على 1000)", () => {
    const c = computePrice(rule({ perKm: 1000n }), 3500, null);
    expect(c.distance).toBe(3500n);
    expect(c.total).toBe(3500n);
    expectBalanced(c);
  });

  it("القسمة الصحيحة تُقرّب لأسفل — لا كسور قروش", () => {
    // 333 × 500 / 1000 = 166.5 → 166 بالقسمة الصحيحة
    const c = computePrice(rule({ perKm: 333n }), 500, null);
    expect(c.distance).toBe(166n);
    expectBalanced(c);
  });

  it("min_total يرفع عبر minAdjustment فقط — المكوّنات الأخرى لا تُمسّ والمعادلة تتوازن", () => {
    const c = computePrice(rule({ base: 1000n, perKm: 1000n, minTotal: 5000n }), 2000, null);
    expect(c.base).toBe(1000n); // v1.1: لا يُدسّ الفرق بأي مكوّن آخر
    expect(c.distance).toBe(2000n);
    expect(c.surge).toBe(0n);
    expect(c.minAdjustment).toBe(2000n);
    expect(c.total).toBe(5000n);
    expectBalanced(c);
  });

  it("minAdjustment = 0 عندما يتجاوز المجموع min_total أصلاً", () => {
    const c = computePrice(rule({ base: 6000n, minTotal: 5000n }), 0, null);
    expect(c.minAdjustment).toBe(0n);
    expect(c.total).toBe(6000n);
    expectBalanced(c);
  });

  it("surge بـ 12000bp = +20% من (base + distance + weight)", () => {
    const c = computePrice(rule({ base: 1000n, perKm: 1000n, surgeMultiplierBp: 12000 }), 3500, null);
    expect(c.surge).toBe(900n); // 20% من 4500
    expect(c.total).toBe(5400n);
    expectBalanced(c);
  });

  it("bp=10000 يعني ×1.0 — surge صفر", () => {
    const c = computePrice(rule({ base: 4500n, surgeMultiplierBp: 10000 }), 0, null);
    expect(c.surge).toBe(0n);
    expectBalanced(c);
  });

  it("وزن null → مكوّن وزن 0", () => {
    const c = computePrice(rule({ perKg: 500n, perKm: 1000n }), 1000, null);
    expect(c.weight).toBe(0n);
    expectBalanced(c);
  });

  it("الوزن غرام وper_kg لكل كغ → قسمة على 1000", () => {
    const c = computePrice(rule({ perKg: 500n }), 0, 2500);
    expect(c.weight).toBe(1250n); // 2.5 كغ × 500
    expectBalanced(c);
  });

  it("bigint صرف — لا فقدان دقة عند مبالغ فوق Number.MAX_SAFE_INTEGER", () => {
    // 2^53 + 1 غير قابل للتمثيل كـ float — أي مرور على Number يُفسد النتيجة
    const huge = 9007199254740993n;
    const c = computePrice(rule({ base: huge, perKm: huge }), 1000, null);
    expect(c.distance).toBe(huge);
    expect(c.total).toBe(18014398509481986n); // huge × 2 بالضبط
    expectBalanced(c);
  });

  it("discount = 0 بالمرحلة الحالية (الكوبونات لاحقاً)", () => {
    const c = computePrice(rule({ base: 1000n }), 0, null);
    expect(c.discount).toBe(0n);
    expectBalanced(c);
  });

  it("يرفض مسافة أو وزناً غير صحيحين أو سالبين برسالة واضحة", () => {
    expect(() => computePrice(rule(), 12.5, null)).toThrow(RangeError);
    expect(() => computePrice(rule(), -1, null)).toThrow(RangeError);
    expect(() => computePrice(rule(), 0, 3.7)).toThrow(RangeError);
    expect(() => computePrice(rule({ surgeMultiplierBp: -1 }), 0, null)).toThrow(RangeError);
  });
});

describe("haversineMeters", () => {
  it("دمشق ← حمص ~140–165كم جواً — ضمن النطاق المعروف", () => {
    const damascus = makePoint(33.5138, 36.2765);
    const homs = makePoint(34.7324, 36.7137);
    const d = haversineMeters(damascus, homs);
    expect(d).toBeGreaterThan(130_000);
    expect(d).toBeLessThan(165_000);
  });

  it("متناظرة والنقطة نفسها = صفر", () => {
    const a = makePoint(33.5138, 36.2765);
    const b = makePoint(34.7324, 36.7137);
    expect(haversineMeters(a, a)).toBe(0);
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });

  it("معامل الطريق الاحتياطي = 1.4 (§7)", () => {
    expect(ROAD_DISTANCE_FALLBACK_FACTOR).toBe(1.4);
  });
});
