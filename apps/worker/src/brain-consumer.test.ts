import { describe, expect, it } from "vitest";
import { brainTargetOrderId } from "./brain-consumer.js";

// منطق ترشيح الدماغ (نقي — بلا mocks للوحدات، فلا تلوّث بين ملفات الاختبار). المسار
// الكامل (جلب الطلب + recompute) مغطّى حياً بـ packages/brain/recompute.integration.
const ORDER = "22222222-2222-4222-8222-222222222222";

describe("brainTargetOrderId — أي حدث يستدعي إعادة حساب الدماغ", () => {
  it("order.status_changed[to=delivered] → معرّف الطلب", () => {
    expect(brainTargetOrderId("order.status_changed", { orderId: ORDER, from: "arrived", to: "delivered" })).toBe(ORDER);
  });

  it("order.status_changed بحالة غير delivered → null (تجاهل)", () => {
    expect(brainTargetOrderId("order.status_changed", { orderId: ORDER, from: "pending", to: "confirmed" })).toBeNull();
    expect(brainTargetOrderId("order.status_changed", { orderId: ORDER, to: "assigned" })).toBeNull();
  });

  it("payment.paid → معرّف الطلب", () => {
    expect(brainTargetOrderId("payment.paid", { orderId: ORDER, paymentRef: "bp-1" })).toBe(ORDER);
  });

  it("موضوع لا يخصّ الدماغ → null", () => {
    expect(brainTargetOrderId("offer.created", { orderId: ORDER })).toBeNull();
    expect(brainTargetOrderId("order.status_changed", { to: "delivered" })).toBeNull(); // بلا orderId
    expect(brainTargetOrderId("payment.paid", { orderId: "not-a-uuid" })).toBeNull();
  });
});
