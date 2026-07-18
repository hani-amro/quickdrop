import { describe, expect, it } from "vitest";
import {
  computeAvgOrderAmount,
  computeLifecycle,
  computeRfm,
  computeTier,
  topFavorites,
  type BrainInputs,
} from "./compute.js";

const base: BrainInputs = { orderCount: 0, totalSpent: 0n, daysSinceLastOrder: null, previousStage: "new" };

describe("computeRfm (منقول من WaFlow، مال BIGINT)", () => {
  it("زبون نشط عالي القيمة → قرب 100", () => {
    // حداثة<7=40، تكرار≥10=30، نقدي≥100000=30 → 100
    expect(computeRfm({ ...base, orderCount: 12, totalSpent: 150_000n, daysSinceLastOrder: 3 })).toBe(100);
  });
  it("زبون متوسط", () => {
    // حداثة<60=20، تكرار≥2=10، نقدي≥10000=10 → 40
    expect(computeRfm({ ...base, orderCount: 3, totalSpent: 20_000n, daysSinceLastOrder: 45 })).toBe(40);
  });
  it("بلا طلبات → حداثة0+تكرار5+نقدي5 = 10", () => {
    expect(computeRfm(base)).toBe(10);
  });
  it("مسقوف بـ100", () => {
    expect(computeRfm({ ...base, orderCount: 99, totalSpent: 10_000_000n, daysSinceLastOrder: 0 })).toBe(100);
  });
});

describe("computeLifecycle (recovered يعتمد المرحلة السابقة)", () => {
  it("0 طلبات → new", () => {
    expect(computeLifecycle(base)).toBe("new");
  });
  it(">90 يوم → churned", () => {
    expect(computeLifecycle({ ...base, orderCount: 3, daysSinceLastOrder: 120 })).toBe("churned");
  });
  it("31–90 يوم → at_risk", () => {
    expect(computeLifecycle({ ...base, orderCount: 3, daysSinceLastOrder: 45 })).toBe("at_risk");
  });
  it("كان at_risk وعاد خلال 30 يوم → recovered", () => {
    expect(computeLifecycle({ ...base, orderCount: 3, daysSinceLastOrder: 10, previousStage: "at_risk" })).toBe("recovered");
  });
  it("≥5 طلبات حديثة → loyal", () => {
    expect(computeLifecycle({ ...base, orderCount: 6, daysSinceLastOrder: 5, previousStage: "active" })).toBe("loyal");
  });
  it("طلبات قليلة حديثة → active", () => {
    expect(computeLifecycle({ ...base, orderCount: 2, daysSinceLastOrder: 5, previousStage: "active" })).toBe("active");
  });
});

describe("computeTier (عتبات BIGINT)", () => {
  it("إنفاق ذهبي → gold", () => {
    expect(computeTier({ ...base, totalSpent: 120_000n }, 50)).toBe("gold");
  });
  it("طلبات كثيرة + rfm عالٍ بلا إنفاق ذهبي → gold", () => {
    expect(computeTier({ ...base, orderCount: 10, totalSpent: 40_000n }, 80)).toBe("gold");
  });
  it("إنفاق فضّي → silver", () => {
    expect(computeTier({ ...base, totalSpent: 40_000n }, 30)).toBe("silver");
  });
  it("دون العتبات → bronze", () => {
    expect(computeTier({ ...base, totalSpent: 5_000n, orderCount: 1 }, 20)).toBe("bronze");
  });
});

describe("computeAvgOrderAmount (قسمة أعداد صحيحة — لا float)", () => {
  it("قسمة صحيحة", () => {
    expect(computeAvgOrderAmount(100_000n, 3)).toBe(33_333n);
  });
  it("صفر طلبات → 0", () => {
    expect(computeAvgOrderAmount(0n, 0)).toBe(0n);
  });
});

describe("topFavorites (بالمعرّف، مجموع الكمية، أعلى 3)", () => {
  it("يجمع الكمية عبر الطلبات ويرتّب تنازلياً", () => {
    const result = topFavorites([
      { catalogItemId: "a", qty: 2 },
      { catalogItemId: "b", qty: 5 },
      { catalogItemId: "a", qty: 3 },
      { catalogItemId: "c", qty: 1 },
      { catalogItemId: "d", qty: 4 },
    ]);
    // تعادل a وb عند 5 → كسر التعادل بالمعرّف تصاعدياً (حتمي): a قبل b
    expect(result).toEqual([
      { catalogItemId: "a", count: 5 },
      { catalogItemId: "b", count: 5 },
      { catalogItemId: "d", count: 4 },
    ]);
  });
  it("أقل من 3 أصناف → يرجّع المتاح", () => {
    expect(topFavorites([{ catalogItemId: "x", qty: 1 }])).toEqual([{ catalogItemId: "x", count: 1 }]);
  });
});
