import type { CartLine } from "./conversation.js";
import { buildCallbackData, UUID_CAPTURE } from "./driver-logic.js";

// §3/§4.4 — منطق تدفق الطعام الصافي (بلا قاعدة ولا شبكة): بنّاؤو callback_data
// وحساب السلة — قابل للاختبار وحدةً (§15) ويستهلكه customer-flow.

// —— callback_data (§4.4: حد 64 بايت — بادئة قصيرة + UUID كامل، لا JSON) ——
// 'm:{uuid}' = 38 بايت، 'ci:{uuid}' = 39 بايت — الاثنان ضمن الحد.
export const CB_FOOD_MERCHANT_PREFIX = "m";
export const CB_FOOD_ITEM_PREFIX = "ci";
export const CB_FOOD_CHECKOUT = "food:checkout";
export const CB_FOOD_CONFIRM = "food:confirm";

/** 'm:{merchantId}' — اختيار مطعم. buildCallbackData يحرس حد الـ 64 بايت (driver-logic). */
export const merchantCb = (merchantId: string): string => buildCallbackData(CB_FOOD_MERCHANT_PREFIX, merchantId);
/** 'ci:{catalogItemId}' — إضافة صنف واحد للسلة. */
export const itemCb = (catalogItemId: string): string => buildCallbackData(CB_FOOD_ITEM_PREFIX, catalogItemId);

// النمط الدقيق (UUID كامل) يمنع التقاط بيانات غريبة الشكل — كأزرار المهام ببوت السائق.
export const MERCHANT_CB_RE = new RegExp(`^${CB_FOOD_MERCHANT_PREFIX}:${UUID_CAPTURE}$`);
export const ITEM_CB_RE = new RegExp(`^${CB_FOOD_ITEM_PREFIX}:${UUID_CAPTURE}$`);

/**
 * §3 — إضافة صنف للسلة: ضغطة واحدة = +1. يعيد سلة جديدة (لا يطفر المدخل — الحالة
 * تُحفظ نصاً بـ Redis والنقاء يبسّط الاختبار). صنف موجود = زيادة كميته؛ وإلا يُلحَق.
 */
export function addToCart(cart: CartLine[], catalogItemId: string): CartLine[] {
  const idx = cart.findIndex((l) => l.catalogItemId === catalogItemId);
  if (idx === -1) return [...cart, { catalogItemId, qty: 1 }];
  return cart.map((l, i) => (i === idx ? { ...l, qty: l.qty + 1 } : l));
}

/** إجمالي عدد القطع بالسلة (مجموع الكميات) — للعرض والتحقق من سلة غير فارغة. */
export function cartItemCount(cart: CartLine[]): number {
  return cart.reduce((sum, l) => sum + l.qty, 0);
}

/**
 * D5 — قيمة البضاعة = Σ سعر×كمية بالـ bigint حصراً. السعر لقطة من الكتالوج وقت العرض
 * (خريطة id→سعر). صنف اختفى/تعطّل بين ضغطتين يُتجاهل بالعرض — الحساب المُلزم يُعاد
 * وقت الإنشاء في resolveFoodOrder (يرمي على صنف غير متاح). للعرض فقط، لا يُخزَّن.
 */
export function computeCartTotal(cart: CartLine[], priceById: Map<string, bigint>): bigint {
  let total = 0n;
  for (const line of cart) {
    const price = priceById.get(line.catalogItemId);
    if (price === undefined) continue;
    total += price * BigInt(line.qty);
  }
  return total;
}
