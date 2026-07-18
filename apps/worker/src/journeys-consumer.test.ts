import { describe, expect, it } from "vitest";
import { journeyTriggerFor } from "./journeys-consumer.js";

// خرط الموضوع→trigger لتسجيل الرحلات (نقي — بلا قاعدة/mocks، فلا تلوّث بين الملفات).
// المسار الحي (حلّ الزبون + enroll + جدولة الخطوة) مغطّى بـ journeys-service.integration.
const USER = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";

describe("journeyTriggerFor — أي حدث spine يسجّل رحلة", () => {
  it("crm.lifecycle_changed → trigger + userId من الحمولة", () => {
    expect(journeyTriggerFor("crm.lifecycle_changed", { userId: USER, from: "active", to: "at_risk" })).toEqual({
      trigger: "crm.lifecycle_changed",
      userId: USER,
    });
  });

  it("contact.created → trigger + userId من الحمولة", () => {
    expect(journeyTriggerFor("contact.created", { userId: USER })).toEqual({ trigger: "contact.created", userId: USER });
  });

  it("order.status_changed[to=delivered] → trigger=order.delivered + orderId (لا userId)", () => {
    expect(journeyTriggerFor("order.status_changed", { orderId: ORDER, from: "arrived", to: "delivered" })).toEqual({
      trigger: "order.delivered",
      orderId: ORDER,
    });
  });

  it("order.status_changed بحالة غير delivered → null", () => {
    expect(journeyTriggerFor("order.status_changed", { orderId: ORDER, to: "assigned" })).toBeNull();
    expect(journeyTriggerFor("order.status_changed", { orderId: ORDER, to: "confirmed" })).toBeNull();
  });

  it("payment.paid → trigger + orderId", () => {
    expect(journeyTriggerFor("payment.paid", { orderId: ORDER, paymentRef: "bp-1" })).toEqual({
      trigger: "payment.paid",
      orderId: ORDER,
    });
  });

  it("حمولة ناقصة/فاسدة → null (لا تسجيل)", () => {
    expect(journeyTriggerFor("crm.lifecycle_changed", { userId: "not-a-uuid" })).toBeNull();
    expect(journeyTriggerFor("contact.created", {})).toBeNull();
    expect(journeyTriggerFor("order.status_changed", { to: "delivered" })).toBeNull(); // بلا orderId
    expect(journeyTriggerFor("payment.paid", { orderId: "not-a-uuid" })).toBeNull();
  });

  it("موضوع لا يخصّ الرحلات → null", () => {
    expect(journeyTriggerFor("offer.created", { orderId: ORDER })).toBeNull();
    expect(journeyTriggerFor("support.reply", { userId: USER })).toBeNull();
  });
});
