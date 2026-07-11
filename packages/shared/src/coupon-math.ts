import type { CouponKind } from "./statuses.js";

// §8.3-4 + §9 v1.1 — المنطق الصافي لحساب خصم الكوبون (بلا قاعدة بيانات).
// D5 والفخ 1: كل الحسابات bigint — ممنوع Number/parseFloat على المال؛ القسمة قسمة أعداد صحيحة.
// يُستورَد من packages/db/src/coupons.ts (طبقة القاعدة) — مصدر حقيقة واحد لصيغة الخصم.

/**
 * §8.3-4 v1.1 — خصم الكوبون من إجمالي التوصيل (subtotal = quote.components.total):
 * - percent: value نقاط أساس (10000 = 100%) → subtotal × value / 10000 قسمةَ أعداد صحيحة.
 * - fixed: value مبلغ ثابت بأصغر وحدة → min(value, subtotal) (لا يتجاوز الإجمالي).
 * - free_delivery: كامل أجرة التوصيل → subtotal.
 *
 * الحد الحاكم (8.3-4): الخصم لا يجعل السعر سالباً — يُقصَّ دائماً إلى subtotal كحد أعلى؛
 * والقيم غير السالبة تضمن ألا ينزل تحت صفر.
 */
export function computeCouponDiscount(kind: CouponKind, value: bigint, subtotal: bigint): bigint {
  if (value < 0n) {
    throw new RangeError(`computeCouponDiscount: value must be non-negative, got ${value}`);
  }
  if (subtotal < 0n) {
    throw new RangeError(`computeCouponDiscount: subtotal must be non-negative, got ${subtotal}`);
  }

  let raw: bigint;
  switch (kind) {
    case "percent":
      raw = (subtotal * value) / 10000n; // value = basis points
      break;
    case "fixed":
      raw = value;
      break;
    case "free_delivery":
      raw = subtotal;
      break;
    default: {
      // §16.12 — نوع كوبون غير معروف = خطأ صريح، لا خصم صفري صامت
      const never: never = kind;
      throw new RangeError(`computeCouponDiscount: unknown coupon kind ${String(never)}`);
    }
  }

  // §8.3-4: القصّ إلى الإجمالي — الخصم لا يتجاوز أجرة التوصيل فلا يصير price_total سالباً.
  return raw > subtotal ? subtotal : raw;
}
