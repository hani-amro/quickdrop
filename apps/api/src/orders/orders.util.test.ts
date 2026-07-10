import type { PriceComponents } from "@quickdrop/shared";
import { describe, expect, it } from "vitest";
import { componentsToStrings, normalizePhoneE164 } from "./orders.util.js";

// اختبارات pure فقط — مسارات REST نفسها (تسعير/إنشاء/قائمة) تحتاج قاعدة حقيقية
// (RLS + withTenant) وتُختبر بالتكامل لاحقاً.

describe("componentsToStrings — D5: bigint→string عند حافة الـ JSON", () => {
  it("يحوّل كل المكوّنات السبعة إلى سلاسل عشرية", () => {
    const components: PriceComponents = {
      base: 5000n,
      distance: 3210n,
      weight: 0n,
      surge: 1642n,
      minAdjustment: 0n,
      discount: 0n,
      total: 9852n,
    };
    expect(componentsToStrings(components)).toEqual({
      base: "5000",
      distance: "3210",
      weight: "0",
      surge: "1642",
      minAdjustment: "0",
      discount: "0",
      total: "9852",
    });
  });

  it("يحافظ على الدقة فوق 2^53 — حيث يفشل Number", () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1: غير قابل للتمثيل بـ Number
    const components: PriceComponents = {
      base: big,
      distance: 0n,
      weight: 0n,
      surge: 0n,
      minAdjustment: 0n,
      discount: 0n,
      total: big,
    };
    const out = componentsToStrings(components);
    expect(out.total).toBe("9007199254740993");
    expect(String(Number(big))).not.toBe("9007199254740993"); // توثيق سبب المنع D5
  });

  it("الناتج قابل لـ JSON.stringify (بينما bigint الخام يرمي)", () => {
    const components: PriceComponents = {
      base: 1n,
      distance: 2n,
      weight: 3n,
      surge: 4n,
      minAdjustment: 5n,
      discount: 6n,
      total: 9n,
    };
    expect(() => JSON.stringify(components)).toThrow();
    expect(() => JSON.stringify(componentsToStrings(components))).not.toThrow();
  });
});

describe("normalizePhoneE164 — تطبيع رقم زبون D15 قبل فهرس (tenant_id, phone_e164)", () => {
  it("يقبل E.164 نظيفاً كما هو", () => {
    expect(normalizePhoneE164("+963951234567")).toBe("+963951234567");
  });

  it("يشيل الفراغات والشرطات والأقواس والنقاط", () => {
    expect(normalizePhoneE164("+963 95-123(45)67")).toBe("+963951234567");
    expect(normalizePhoneE164(" +963.951.234.567 ")).toBe("+963951234567");
  });

  it("يحوّل بادئة 00 الدولية إلى +", () => {
    expect(normalizePhoneE164("00963951234567")).toBe("+963951234567");
  });

  it("يحوّل الأرقام العربية الشرقية والفارسية إلى ASCII", () => {
    expect(normalizePhoneE164("+٩٦٣٩٥١٢٣٤٥٦٧")).toBe("+963951234567");
    expect(normalizePhoneE164("+۹۶۳۹۵۱۲۳۴۵۶۷")).toBe("+963951234567");
  });

  it("يرفض المحلي بلا بادئة دولية — لا استنتاج بلد بنظام متعدد المستأجرين", () => {
    expect(normalizePhoneE164("0951234567")).toBeNull();
  });

  it("يرفض القصير جداً والطويل جداً وصفر بعد +", () => {
    expect(normalizePhoneE164("+96395")).toBeNull(); // أقل من 8 خانات
    expect(normalizePhoneE164("+9639512345678901")).toBeNull(); // أكثر من 15
    expect(normalizePhoneE164("+0963951234567")).toBeNull(); // صفر بعد +
  });

  it("يرفض الحروف وأي رموز أخرى", () => {
    expect(normalizePhoneE164("+96395abc4567")).toBeNull();
    expect(normalizePhoneE164("phone")).toBeNull();
  });
});
