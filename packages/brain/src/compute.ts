import type { LifecycleStage, LoyaltyTier } from "@quickdrop/shared";

// دمج WaFlow (MERGE_PLAN §3.3) — دماغ الزبون: دوال نقية تُنقل من WaFlow customer-brain.ts
// **بمال BIGINT** (كان Float RM) وعتبات أعداد صحيحة. مصدر الحقيقة orders؛ هذه الدوال
// تحسب القيم المشتقة (RFM/lifecycle/tier/favorites) من مجاميع مسبقة الحساب.

/** عتبات الدماغ — v1 ثوابت، قابلة للتحويل لأعمدة لكل مستأجر لاحقاً (§9 مثل معدلات الولاء).
 *  المبالغ بأصغر وحدة (D5). الافتراضات بـ MYR sen (×100 من قيم WaFlow الأصلية بالـ RM). */
export interface BrainThresholds {
  /** RFM النقدي: [ذهبي, فضّي, برونزي] بأصغر وحدة (WaFlow: 1000/500/100 RM) */
  rfmMonetary: readonly [bigint, bigint, bigint];
  /** المستوى النقدي: [gold, silver] بأصغر وحدة (WaFlow: 1000/300 RM) */
  tierMonetary: readonly [bigint, bigint];
}

export const DEFAULT_THRESHOLDS: BrainThresholds = {
  rfmMonetary: [100_000n, 50_000n, 10_000n],
  tierMonetary: [100_000n, 30_000n],
};

export interface BrainInputs {
  orderCount: number;
  totalSpent: bigint; // أصغر وحدة
  /** أيام منذ آخر طلب مُسلَّم؛ null = لا طلبات بعد */
  daysSinceLastOrder: number | null;
  previousStage: LifecycleStage;
}

/** RFM مركّب 0–100 = حداثة (0–40) + تكرار (0–30) + نقدي (0–30). منقول حرفياً من WaFlow. */
export function computeRfm(input: BrainInputs, thresholds: BrainThresholds = DEFAULT_THRESHOLDS): number {
  const d = input.daysSinceLastOrder;
  const recency = d === null ? 0 : d < 7 ? 40 : d < 30 ? 30 : d < 60 ? 20 : d < 90 ? 10 : 0;
  const frequency = input.orderCount >= 10 ? 30 : input.orderCount >= 5 ? 20 : input.orderCount >= 2 ? 10 : 5;
  const [m1, m2, m3] = thresholds.rfmMonetary;
  const monetary = input.totalSpent >= m1 ? 30 : input.totalSpent >= m2 ? 20 : input.totalSpent >= m3 ? 10 : 5;
  return Math.min(100, recency + frequency + monetary);
}

/** مرحلة دورة الحياة — منقولة حرفياً من WaFlow (recovered يعتمد المرحلة السابقة). */
export function computeLifecycle(input: BrainInputs): LifecycleStage {
  if (input.orderCount === 0) return "new";
  const d = input.daysSinceLastOrder;
  if (d !== null && d > 90) return "churned";
  if (d !== null && d > 30) return "at_risk";
  if ((input.previousStage === "at_risk" || input.previousStage === "churned") && (d === null || d <= 30)) {
    return "recovered";
  }
  if (input.orderCount >= 5) return "loyal";
  return "active";
}

/** المستوى — منقول من WaFlow computeTier بعتبات BIGINT. */
export function computeTier(
  input: BrainInputs,
  rfm: number,
  thresholds: BrainThresholds = DEFAULT_THRESHOLDS,
): LoyaltyTier {
  const [gold, silver] = thresholds.tierMonetary;
  if (input.totalSpent >= gold || (input.orderCount >= 10 && rfm >= 75)) return "gold";
  if (input.totalSpent >= silver || (input.orderCount >= 4 && rfm >= 50)) return "silver";
  return "bronze";
}

/** متوسط قيمة الطلب — قسمة أعداد صحيحة (D5: لا float على المال). */
export function computeAvgOrderAmount(totalSpent: bigint, orderCount: number): bigint {
  return orderCount > 0 ? totalSpent / BigInt(orderCount) : 0n;
}

export interface FavoriteItem {
  catalogItemId: string;
  count: number;
}

/** أعلى 3 أصناف بمجموع الكمية — بالمعرّف لا بالاسم (§3.3 landing؛ WaFlow كان بالاسم). */
export function topFavorites(counts: { catalogItemId: string; qty: number }[], limit = 3): FavoriteItem[] {
  const byItem = new Map<string, number>();
  for (const c of counts) byItem.set(c.catalogItemId, (byItem.get(c.catalogItemId) ?? 0) + c.qty);
  return [...byItem.entries()]
    .map(([catalogItemId, count]) => ({ catalogItemId, count }))
    .sort((a, b) => b.count - a.count || a.catalogItemId.localeCompare(b.catalogItemId))
    .slice(0, limit);
}
