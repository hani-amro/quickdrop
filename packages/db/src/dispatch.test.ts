import { MAX_DISPATCH_ROUNDS, ORDER_STATUSES, type OrderStatus } from "@quickdrop/shared";
import { describe, expect, it, vi } from "vitest";

// اختبارات pure على ثوابت/منطق §6 القابل للفصل فقط — startRound/acceptOffer/
// handleOfferTimeout تحتاج قاعدة حقيقية (أقفال صفوف + RLS + PostGIS) وتُختبر
// بالتكامل لاحقاً. الموك يعزل ./outbox.js عن تحميل هذا الملف — لا يُستدعى هنا أصلاً
// (نفس نمط state-machine.test.ts).
vi.mock("./outbox.js", () => ({
  writeOutbox: vi.fn(async () => ({ id: "00000000-0000-0000-0000-000000000000" })),
}));

import {
  DRIVER_ACTIVE_ORDER_STATUSES,
  LOCATION_FRESHNESS_S,
  MAX_CANDIDATES_PER_ROUND,
  ROUND_RADII_M,
  radiusForRound,
} from "./dispatch.js";

describe("ROUND_RADII_M — أنصاف أقطار الجولات §6.1", () => {
  it("القيم حرفياً من الوثيقة: 3كم ثم 6كم ثم 10كم", () => {
    expect([...ROUND_RADII_M]).toEqual([3_000, 6_000, 10_000]);
  });

  it("تتوسع بصرامة مع كل جولة — جولة أضيق من سابقتها بلا معنى", () => {
    for (let i = 1; i < ROUND_RADII_M.length; i++) {
      expect(ROUND_RADII_M[i]).toBeGreaterThan(ROUND_RADII_M[i - 1] ?? Number.POSITIVE_INFINITY);
    }
  });

  it("قائمة الأقطار تغطي MAX_DISPATCH_ROUNDS بالضبط — لا جولة معرَّفة بلا نطاق", () => {
    // لو رُفع MAX_DISPATCH_ROUNDS بالمستقبل: radiusForRound يثبت على الأوسع،
    // لكن التطابق الحالي مقصود ومُثبَّت هنا.
    expect(ROUND_RADII_M.length).toBe(MAX_DISPATCH_ROUNDS);
  });
});

describe("radiusForRound — §6.2", () => {
  it("الجولات 1..3 تُرجع نطاقها المعرَّف", () => {
    expect(radiusForRound(1)).toBe(3_000);
    expect(radiusForRound(2)).toBe(6_000);
    expect(radiusForRound(3)).toBe(10_000);
  });

  it("جولة فوق آخر مُعرَّف تثبت على الأوسع — لا انفجار لو توسعت الجولات لاحقاً", () => {
    expect(radiusForRound(MAX_DISPATCH_ROUNDS + 1)).toBe(10_000);
    expect(radiusForRound(99)).toBe(10_000);
  });

  it("جولة غير صحيحة = باغ مستدعٍ → RangeError صاخب (§16.12)، لا نطاق افتراضي صامت", () => {
    expect(() => radiusForRound(0)).toThrow(RangeError);
    expect(() => radiusForRound(-1)).toThrow(RangeError);
    expect(() => radiusForRound(1.5)).toThrow(RangeError);
    expect(() => radiusForRound(Number.NaN)).toThrow(RangeError);
    expect(() => radiusForRound(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("DRIVER_ACTIVE_ORDER_STATUSES — اشتقاق الانشغال D14", () => {
  it("يطابق assigned..arrived حرفياً — لا أقل (تسريب سعة) ولا أكثر (حجز زائف)", () => {
    expect([...DRIVER_ACTIVE_ORDER_STATUSES]).toEqual(["assigned", "picked_up", "in_transit", "arrived"]);
  });

  it("كل عضو حالة طلب صالحة من مصدر الحقيقة المشترك", () => {
    for (const s of DRIVER_ACTIVE_ORDER_STATUSES) {
      expect(ORDER_STATUSES).toContain(s);
    }
  });

  it("الحالات النهائية وما قبل الإسناد لا تستهلك سعة السائق", () => {
    const active: readonly OrderStatus[] = DRIVER_ACTIVE_ORDER_STATUSES;
    const mustBeInactive: OrderStatus[] = [
      "draft",
      "scheduled",
      "pending",
      "confirmed",
      "delivered",
      "cancelled_by_customer",
      "cancelled_by_office",
      "failed",
      "returned",
    ];
    for (const s of mustBeInactive) {
      expect(active).not.toContain(s);
    }
    // اكتمال التقسيم: نشط + غير نشط = كل الحالات بلا تقاطع
    expect(active.length + mustBeInactive.length).toBe(ORDER_STATUSES.length);
  });
});

describe("ثوابت الترشيح §6.1", () => {
  it("top 5 مرشّحين لكل جولة", () => {
    expect(MAX_CANDIDATES_PER_ROUND).toBe(5);
  });

  it("طزاجة الموقع: أحدث من دقيقتين", () => {
    expect(LOCATION_FRESHNESS_S).toBe(120);
  });
});
