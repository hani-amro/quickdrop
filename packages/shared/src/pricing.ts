// §8.3-1 + §3 pricing_rules — المنطق الصافي لمحرك التسعير (بلا قاعدة بيانات).
// D5 والفخ 1: كل الحسابات bigint — ممنوع Number/parseFloat على المال؛ القسمة قسمة أعداد صحيحة.

/** الشكل الأدنى لقاعدة التسعير الذي يحتاجه الحساب — pricing_rules بالقسم 3 يطابقه بنيوياً. */
export interface PricingRuleLike {
  base: bigint;
  perKm: bigint;
  perKg: bigint;
  minTotal: bigint;
  /** basis points: 10000 = ×1.0 (بلا زيادة)، 12000 = +20%. */
  surgeMultiplierBp: number;
}

/** §8.3-1: total = base + distance + weight + surge + minAdjustment − discount — دائماً. */
export interface PriceComponents {
  base: bigint;
  distance: bigint;
  weight: bigint;
  surge: bigint;
  minAdjustment: bigint;
  discount: bigint;
  total: bigint;
}

/**
 * حساب مكوّنات السعر من قاعدة تسعير ومسافة (بالمتر) ووزن (بالغرام، NULL = بلا وزن).
 * - المسافة بالمتر وper_km لكل كم → (perKm × distanceM) / 1000 قسمةَ أعداد صحيحة bigint.
 * - الوزن بالغرام وper_kg لكل كغ → نفس القسمة على 1000.
 * - surge يُحسب على (base + distance + weight) بفارق الـ bp عن 10000.
 * - v1.1: الرفع إلى min_total مكوّن مسمّى minAdjustment — لا يُدسّ بمكوّن آخر (§3 price_min_adjustment).
 * - discount = 0 هنا — الكوبونات/الولاء مرحلة لاحقة وتُمرَّر كمكوّن مستقل حين تُبنى.
 */
export function computePrice(rule: PricingRuleLike, distanceM: number, weightG: number | null): PriceComponents {
  // BigInt() يرمي على الكسور أصلاً — لكن نرمي رسالة واضحة بدلاً من خطأ تحويل غامض.
  if (!Number.isInteger(distanceM) || distanceM < 0) {
    throw new RangeError(`computePrice: distanceM must be a non-negative integer, got ${distanceM}`);
  }
  if (weightG !== null && (!Number.isInteger(weightG) || weightG < 0)) {
    throw new RangeError(`computePrice: weightG must be null or a non-negative integer, got ${weightG}`);
  }
  if (!Number.isInteger(rule.surgeMultiplierBp) || rule.surgeMultiplierBp < 0) {
    throw new RangeError(`computePrice: surgeMultiplierBp must be a non-negative integer, got ${rule.surgeMultiplierBp}`);
  }

  const base = rule.base;
  const distance = (rule.perKm * BigInt(distanceM)) / 1000n;
  const weight = weightG === null ? 0n : (rule.perKg * BigInt(weightG)) / 1000n;

  // bp = 10000 يعني ×1.0 → surge = 0؛ 12000 → +20% من (base + distance + weight).
  const beforeSurge = base + distance + weight;
  const surge = (beforeSurge * BigInt(rule.surgeMultiplierBp - 10000)) / 10000n;

  // الرفع إلى min_total يُقاس بعد الـ surge كي يبقى الإجمالي ≥ min_total فعلاً.
  const subtotal = beforeSurge + surge;
  const minAdjustment = rule.minTotal > subtotal ? rule.minTotal - subtotal : 0n;

  const discount = 0n;

  // §8.3-1 (invariant مع CHECK بالقاعدة): المعادلة الكاملة — لا اختصارات.
  const total = base + distance + weight + surge + minAdjustment - discount;

  return { base, distance, weight, surge, minAdjustment, discount, total };
}
