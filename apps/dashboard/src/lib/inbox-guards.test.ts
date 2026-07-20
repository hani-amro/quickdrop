import { describe, expect, it } from "vitest";
import { isResponseForSelected, shouldRecordInboxError, shouldShowInboxError } from "./inbox-guards.js";

// §25/مراجعة Phase 4 (correctness) — تثبيت الإصلاحين اللذين لقطتهما المراجعة المستقلة:
// (1) فشل poll/realtime خلفي لا يهدم الوارد؛ (2) حارس سباق الترتيب على الاستجابات.

describe("shouldShowInboxError — شاشة الخطأ على التحميل الأولي فقط", () => {
  it("تحميل أولي فشل (لا قائمة) + خطأ → اعرض", () => {
    expect(shouldShowInboxError(null, 500)).toBe(true);
  });
  it("قائمة محمّلة (ولو فارغة) + خطأ عابر → لا تهدم الواجهة", () => {
    expect(shouldShowInboxError([], 500)).toBe(false); // وارد فارغ = محمّل صالح
    expect(shouldShowInboxError([{ id: "c1" }], 503)).toBe(false);
  });
  it("لا خطأ → لا شاشة خطأ", () => {
    expect(shouldShowInboxError(null, null)).toBe(false);
    expect(shouldShowInboxError([{ id: "c1" }], null)).toBe(false);
  });
});

describe("shouldRecordInboxError — سجّل الخطأ على التحميل الأولي فقط", () => {
  it("لا قائمة بعد → سجّل (تحميل أولي)", () => {
    expect(shouldRecordInboxError(null)).toBe(true);
  });
  it("قائمة محمّلة (ولو فارغة) → ابتلع الفشل الخلفي (لا تسجيل يهدم الواجهة)", () => {
    expect(shouldRecordInboxError([])).toBe(false);
    expect(shouldRecordInboxError([{ id: "c1" }])).toBe(false);
  });
});

describe("isResponseForSelected — حارس سباق ترتيب الاستجابات", () => {
  it("الاستجابة لخيط لا يزال المحدَّد → طبّق", () => {
    expect(isResponseForSelected("A", "A")).toBe(true);
  });
  it("بدّل المستخدم لـ B قبل وصول استجابة A → تجاهل A القديمة", () => {
    expect(isResponseForSelected("B", "A")).toBe(false);
  });
  it("لا خيط محدَّد → لا تطبيق", () => {
    expect(isResponseForSelected(null, "A")).toBe(false);
  });
});
