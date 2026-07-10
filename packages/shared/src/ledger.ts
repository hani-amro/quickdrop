import type { LedgerEntryType } from "./statuses.js";

// §8.1 v1.1 — قيود التسليم بنموذج D13 (السائق دفع البضاعة من جيبته عند الاستلام).
// المنظور المُلزم: موجب = بذمة السائق للمكتب. منطق صافٍ — الكتابة بالقاعدة
// مسؤولية transition() بنفس ترانزاكشن الانتقال.

export interface DeliveryLedgerInput {
  /** أجرة التوصيل الكاملة (orders.price_total). */
  priceTotal: bigint;
  /** ثمن البضاعة الذي دفعه السائق للتاجر (orders.goods_amount) — D13. */
  goodsAmount: bigint;
  /** المُحصَّل فعلياً من الزبون (الفخ 18) — قيد التحصيل يُسجَّل به لا بالمتوقع (§8.4). */
  codReceived: bigint;
}

export interface DeliveryLedgerEntry {
  entryType: LedgerEntryType;
  amount: bigint;
}

/**
 * §8.3-2 v1.1 — قيد delivery_fee_earned واحد دائماً، وcod_collected إذا حُصِّل كاش،
 * وgoods_paid_by_driver إذا goods_amount > 0. الأصفار تُحذف (CHECK الإشارة يمنعها).
 *
 * صافي ذمة السائق عن الطلب = codReceived − goods − حصته من الأجرة (= حصة المكتب
 * عند التحصيل الكامل).
 */
export function computeDeliveryLedger(input: DeliveryLedgerInput, driverFeeShareBp: number): DeliveryLedgerEntry[] {
  if (input.priceTotal < 0n || input.goodsAmount < 0n || input.codReceived < 0n) {
    throw new RangeError("computeDeliveryLedger: amounts must be non-negative");
  }
  if (!Number.isInteger(driverFeeShareBp) || driverFeeShareBp < 0 || driverFeeShareBp > 10000) {
    throw new RangeError("computeDeliveryLedger: driverFeeShareBp must be an integer in [0, 10000]");
  }

  const driverFee = (input.priceTotal * BigInt(driverFeeShareBp)) / 10000n;

  const entries: DeliveryLedgerEntry[] = [];
  if (input.codReceived > 0n) {
    entries.push({ entryType: "cod_collected", amount: input.codReceived });
  }
  if (input.goodsAmount > 0n) {
    entries.push({ entryType: "goods_paid_by_driver", amount: -input.goodsAmount });
  }
  if (driverFee > 0n) {
    entries.push({ entryType: "delivery_fee_earned", amount: -driverFee });
  }
  return entries;
}
