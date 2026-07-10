import { ORDER_ACTOR_TYPES, ORDER_STATUSES, type OrderActorType, type OrderStatus } from "@quickdrop/shared";
import { describe, expect, it, vi } from "vitest";

// اختبارات pure على جدول §5 فقط — transition() نفسها تحتاج قاعدة حقيقية
// (قفل صف + RLS) وتُختبر بالتكامل لاحقاً. الموك يعزل ./outbox.js
// (ملف وحدة أخرى) عن تحميل هذا الملف — لا يُستدعى هنا أصلاً.
vi.mock("./outbox.js", () => ({
  writeOutbox: vi.fn(async () => ({ id: "00000000-0000-0000-0000-000000000000" })),
}));

import { InvalidTransitionError, TRANSITIONS } from "./state-machine.js";

function allowed(from: OrderStatus, to: OrderStatus, actor: OrderActorType): boolean {
  return TRANSITIONS[from].some((t) => t.to === to && t.allowedActors.includes(actor));
}

describe("TRANSITIONS — جدول §5 v1.1 بالكامل", () => {
  it("يغطي كل الحالات كمفاتيح وقيمه أعضاء صالحون", () => {
    for (const status of ORDER_STATUSES) {
      expect(TRANSITIONS[status]).toBeDefined();
      for (const rule of TRANSITIONS[status]) {
        expect(ORDER_STATUSES).toContain(rule.to);
        expect(rule.allowedActors.length).toBeGreaterThan(0);
        for (const actor of rule.allowedActors) {
          expect(ORDER_ACTOR_TYPES).toContain(actor);
        }
      }
    }
  });

  it("مجموعة الأضلاع مطابقة تماماً لنص §5 — لا أضلاع زائدة ولا ناقصة", () => {
    const expected: `${OrderStatus}->${OrderStatus}`[] = [
      "draft->pending",
      "draft->scheduled",
      "scheduled->pending",
      "scheduled->cancelled_by_customer",
      "scheduled->cancelled_by_office",
      "pending->confirmed",
      "pending->cancelled_by_customer",
      "pending->cancelled_by_office",
      "confirmed->assigned",
      "confirmed->cancelled_by_customer",
      "confirmed->cancelled_by_office",
      "assigned->picked_up",
      "assigned->failed",
      "picked_up->in_transit",
      "picked_up->failed",
      "in_transit->arrived",
      "in_transit->failed",
      "arrived->delivered",
      "arrived->failed",
      "failed->returned",
    ];
    const actual = ORDER_STATUSES.flatMap((from) => TRANSITIONS[from].map((t) => `${from}->${t.to}`));
    expect(actual.sort()).toEqual([...expected].sort());
  });

  it("المسار السعيد الكامل مسموح بالفاعلين الصحيحين", () => {
    expect(allowed("draft", "pending", "customer")).toBe(true);
    expect(allowed("draft", "pending", "staff")).toBe(true);
    expect(allowed("pending", "confirmed", "staff")).toBe(true);
    expect(allowed("pending", "confirmed", "system")).toBe(true);
    expect(allowed("confirmed", "assigned", "driver")).toBe(true);
    expect(allowed("confirmed", "assigned", "staff")).toBe(true);
    expect(allowed("confirmed", "assigned", "system")).toBe(true);
    expect(allowed("assigned", "picked_up", "driver")).toBe(true);
    expect(allowed("picked_up", "in_transit", "system")).toBe(true);
    expect(allowed("picked_up", "in_transit", "driver")).toBe(true); // زر السائق كاحتياط
    expect(allowed("in_transit", "arrived", "system")).toBe(true); // الـ geofence (§7)
    expect(allowed("in_transit", "arrived", "driver")).toBe(true);
    expect(allowed("arrived", "delivered", "driver")).toBe(true);
    expect(allowed("arrived", "delivered", "staff")).toBe(true);
  });

  it("المسار المجدول: تأكيد بموعد، إطلاق عند الموعد بفاعل system حصراً", () => {
    expect(allowed("draft", "scheduled", "customer")).toBe(true);
    expect(allowed("draft", "scheduled", "staff")).toBe(true);
    expect(allowed("scheduled", "pending", "system")).toBe(true);
    expect(allowed("scheduled", "pending", "staff")).toBe(false);
    expect(allowed("scheduled", "pending", "customer")).toBe(false);
    expect(allowed("scheduled", "pending", "driver")).toBe(false);
  });

  it("الإلغاء: الزبون يلغي كزبون والموظف كمكتب — لا تبادل أدوار", () => {
    for (const from of ["scheduled", "pending", "confirmed"] as const) {
      expect(allowed(from, "cancelled_by_customer", "customer")).toBe(true);
      expect(allowed(from, "cancelled_by_office", "staff")).toBe(true);
      expect(allowed(from, "cancelled_by_customer", "staff")).toBe(false);
      expect(allowed(from, "cancelled_by_office", "customer")).toBe(false);
      expect(allowed(from, "cancelled_by_customer", "driver")).toBe(false);
      expect(allowed(from, "cancelled_by_office", "system")).toBe(false);
    }
  });

  it("الفشل من كل الحالات النشطة بعد الإسناد ثم الإرجاع (driver/staff فقط)", () => {
    for (const from of ["assigned", "picked_up", "in_transit", "arrived"] as const) {
      expect(allowed(from, "failed", "driver")).toBe(true);
      expect(allowed(from, "failed", "staff")).toBe(true);
      expect(allowed(from, "failed", "customer")).toBe(false);
      expect(allowed(from, "failed", "system")).toBe(false);
    }
    expect(allowed("failed", "returned", "driver")).toBe(true);
    expect(allowed("failed", "returned", "staff")).toBe(true);
    expect(allowed("failed", "returned", "customer")).toBe(false);
    expect(allowed("failed", "returned", "system")).toBe(false);
  });

  it("عينات ممنوعة صراحةً — لأي فاعل كان", () => {
    const forbidden: [OrderStatus, OrderStatus][] = [
      ["delivered", "pending"], // لا رجوع من النهائية
      ["confirmed", "picked_up"], // لا قفز فوق assigned
      ["scheduled", "assigned"], // المجدول يمر من pending أولاً
      ["picked_up", "assigned"], // إعادة إسناد بعد الاستلام — لازم failed أولاً (§5)
      ["draft", "confirmed"],
      ["pending", "assigned"],
      ["assigned", "in_transit"],
      ["failed", "delivered"],
      ["delivered", "returned"],
      ["arrived", "cancelled_by_customer"], // لا إلغاء بعد الإسناد — مساره failed
    ];
    for (const [from, to] of forbidden) {
      for (const actor of ORDER_ACTOR_TYPES) {
        expect(allowed(from, to, actor)).toBe(false);
      }
    }
  });

  it("الفاعلون الخطأ على انتقالات صحيحة", () => {
    expect(allowed("confirmed", "assigned", "customer")).toBe(false); // زبون لا يُسند
    expect(allowed("pending", "confirmed", "customer")).toBe(false);
    expect(allowed("pending", "confirmed", "driver")).toBe(false);
    expect(allowed("assigned", "picked_up", "staff")).toBe(false); // الاستلام بيد السائق وحده
    expect(allowed("assigned", "picked_up", "system")).toBe(false);
    expect(allowed("arrived", "delivered", "system")).toBe(false); // التسليم قرار بشري
    expect(allowed("arrived", "delivered", "customer")).toBe(false);
    expect(allowed("draft", "pending", "driver")).toBe(false);
    expect(allowed("draft", "pending", "system")).toBe(false);
  });

  it("الحالات النهائية بلا انتقالات خارجة", () => {
    for (const terminal of ["delivered", "returned", "cancelled_by_customer", "cancelled_by_office"] as const) {
      expect(TRANSITIONS[terminal]).toEqual([]);
    }
  });
});

describe("InvalidTransitionError", () => {
  it("يحمل from/to/actorType ويرث Error", () => {
    const err = new InvalidTransitionError("delivered", "pending", "customer");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("InvalidTransitionError");
    expect(err.from).toBe("delivered");
    expect(err.to).toBe("pending");
    expect(err.actorType).toBe("customer");
    expect(err.message).toContain("delivered");
    expect(err.message).toContain("pending");
  });
});
