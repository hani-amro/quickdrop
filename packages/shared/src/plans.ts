import type { TenantPlan } from "./statuses.js";

// §14 — حدود الباقات. منطق صافٍ (بلا قاعدة وبلا Nest) — مصدر الحقيقة الوحيد لسقوف
// الباقات، وعليه يُبنى فرضها بالقاعدة (canActivateDriver في @quickdrop/db).

/**
 * §14 — أقصى عدد سائقين مفعّلين لكل باقة. pro بلا سقف (Infinity — يبقى دائماً
 * currentCount < الحد). القيم أعلاه = قرار تجاري قابل للتعديل بمكان واحد.
 */
export const PLAN_DRIVER_LIMITS: Record<TenantPlan, number> = {
  starter: 3,
  growth: 10,
  pro: Number.POSITIVE_INFINITY,
};

/**
 * §14 — منطق صافٍ قابل لاختبار الوحدات: هل تسمح الباقة بتفعيل سائق إضافي بالنظر
 * إلى العدد الحالي؟ نضيف واحداً إن كان العدد الحالي أقل من الحد (< لا ≤: العدد
 * الحالي لا يشمل السائق الجديد). currentCount غير صحيح (سالب/كسري) = باغ مستدعٍ →
 * RangeError صاخب (§16.12)، لا سماح افتراضي صامت.
 */
export function planAllowsDriverCount(plan: TenantPlan, currentCount: number): boolean {
  if (!Number.isInteger(currentCount) || currentCount < 0) {
    throw new RangeError(`planAllowsDriverCount: currentCount must be a non-negative integer, got ${currentCount}`);
  }
  return currentCount < PLAN_DRIVER_LIMITS[plan];
}
