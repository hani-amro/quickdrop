import { describe, expect, it } from "vitest";
import { isSessionGuardedPath, readRequestedTenantSlugs } from "./session.guard.js";

// §10.2/§10.3 — أي مسار /api/* محروس بجلسة الطاقم افتراضياً (لا فتح مفتوح)، عدا نطاقات
// ذاتية المصادقة صراحةً. انحدار: نسيان استثناء /api/miniapp كان سيمنع التطبيق كلياً،
// وإضافة مسار طاقم للقائمة البيضاء خطأً يكشفه بلا مصادقة.
describe("isSessionGuardedPath", () => {
  it("يحرس مسارات الطاقم العامة", () => {
    expect(isSessionGuardedPath("/api/orders")).toBe(true);
    expect(isSessionGuardedPath("/api/merchants")).toBe(true);
    expect(isSessionGuardedPath("/api/support/abc")).toBe(true);
  });

  it("لا يحرس نطاق المشرف (مصادقة منفصلة §10.2)", () => {
    expect(isSessionGuardedPath("/api/admin")).toBe(false);
    expect(isSessionGuardedPath("/api/admin/impersonate")).toBe(false);
  });

  it("لا يحرس نطاق الـ Mini App (ذاتي المصادقة §10.3)", () => {
    expect(isSessionGuardedPath("/api/miniapp")).toBe(false);
    expect(isSessionGuardedPath("/api/miniapp/auth")).toBe(false);
    expect(isSessionGuardedPath("/api/miniapp/restaurants")).toBe(false);
    // Express غير حسّاس لحالة الأحرف — التطبيع يمنع تخطّي الحارس أو منع الوصول بحالة مختلطة
    expect(isSessionGuardedPath("/API/MiniApp/Auth")).toBe(false);
  });

  it("خارج /api/* ليس نطاق الطاقم", () => {
    expect(isSessionGuardedPath("/health")).toBe(false);
    expect(isSessionGuardedPath("/public/track/x")).toBe(false);
  });

  it("لا يُخدع بشرطة زائدة (routing غير صارم) — مسار الدخول يبقى معفى", () => {
    expect(isSessionGuardedPath("/api/auth/login/")).toBe(false);
    expect(isSessionGuardedPath("/api/admin/")).toBe(false);
  });
});

// §11 حرج — الحارس يقارن tenantSlug بنطاق الجلسة؛ يجب أن يرى **كل** المصادر (جسم واستعلام)
// وإلا يمرّر مهاجمٌ slug نفسه بالجسم وslug الضحية بالاستعلام (تقرؤه خدمات GET) → تسرّب.
describe("readRequestedTenantSlugs", () => {
  it("يجمع slug الجسم والاستعلام معاً (لا الأول فقط)", () => {
    expect(readRequestedTenantSlugs({ tenantSlug: "a" }, { tenantSlug: "victim" })).toEqual(["a", "victim"]);
  });
  it("انحدار الثغرة: جسم-خادع + استعلام-ضحية → القائمة تحوي slug الضحية فيُرفض بالحارس", () => {
    const slugs = readRequestedTenantSlugs({ tenantSlug: "attacker" }, { tenantSlug: "victim" });
    expect(slugs.some((s) => s !== "attacker")).toBe(true); // "victim" ≠ session → رفض
  });
  it("مصدر واحد أو لا شيء", () => {
    expect(readRequestedTenantSlugs({ tenantSlug: "a" }, {})).toEqual(["a"]);
    expect(readRequestedTenantSlugs({}, { tenantSlug: "a" })).toEqual(["a"]);
    expect(readRequestedTenantSlugs({}, {})).toEqual([]);
    expect(readRequestedTenantSlugs(null, {})).toEqual([]);
  });
});
