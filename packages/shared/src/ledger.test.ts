import { describe, expect, it } from "vitest";
import { computeDeliveryLedger } from "./ledger.js";

// §8.1 v1.1 — مثال الوثيقة حرفياً: cod 18,000 = بضاعة 12,000 + توصيل 6,000،
// حصة السائق 75% من الأجرة (4,500) ⇒ صافي ذمته = 1,500 (حصة المكتب).
describe("computeDeliveryLedger", () => {
  it("matches the doc §8.1 worked example", () => {
    const entries = computeDeliveryLedger(
      { priceTotal: 6000n, goodsAmount: 12000n, codReceived: 18000n },
      7500,
    );
    expect(entries).toEqual([
      { entryType: "cod_collected", amount: 18000n },
      { entryType: "goods_paid_by_driver", amount: -12000n },
      { entryType: "delivery_fee_earned", amount: -4500n },
    ]);
    const net = entries.reduce((s, e) => s + e.amount, 0n);
    expect(net).toBe(1500n); // موجب = بذمة السائق للمكتب
  });

  it("omits cod_collected for a fully-free order (8.3-2: CHECK > 0 stays intact)", () => {
    const entries = computeDeliveryLedger({ priceTotal: 0n, goodsAmount: 0n, codReceived: 0n }, 10000);
    expect(entries).toEqual([]);
  });

  it("omits goods entry for p2p (no goods) and records short cash as-is (trap 18)", () => {
    // الزبون دفع 4,000 من أصل 5,000 — القيد بالمستلَم الفعلي والفرق يظهر بالتسوية (§8.4)
    const entries = computeDeliveryLedger({ priceTotal: 5000n, goodsAmount: 0n, codReceived: 4000n }, 10000);
    expect(entries).toEqual([
      { entryType: "cod_collected", amount: 4000n },
      { entryType: "delivery_fee_earned", amount: -5000n },
    ]);
  });

  it("driver share of zero produces no fee entry", () => {
    const entries = computeDeliveryLedger({ priceTotal: 5000n, goodsAmount: 0n, codReceived: 5000n }, 0);
    expect(entries).toEqual([{ entryType: "cod_collected", amount: 5000n }]);
  });

  it("uses integer bigint math — no precision loss on large amounts", () => {
    const entries = computeDeliveryLedger(
      { priceTotal: 9_007_199_254_740_993n, goodsAmount: 0n, codReceived: 9_007_199_254_740_993n },
      5000,
    );
    expect(entries[1]).toEqual({ entryType: "delivery_fee_earned", amount: -4_503_599_627_370_496n });
  });

  it("rejects negative amounts and out-of-range share", () => {
    expect(() => computeDeliveryLedger({ priceTotal: -1n, goodsAmount: 0n, codReceived: 0n }, 10000)).toThrow(RangeError);
    expect(() => computeDeliveryLedger({ priceTotal: 0n, goodsAmount: 0n, codReceived: 0n }, 10001)).toThrow(RangeError);
    expect(() => computeDeliveryLedger({ priceTotal: 0n, goodsAmount: 0n, codReceived: 0n }, 2.5)).toThrow(RangeError);
  });
});
