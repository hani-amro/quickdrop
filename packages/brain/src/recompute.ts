import { customerProfiles, loyaltyAccounts, orderItems, orders, type Tx } from "@quickdrop/db";
import { publishSpineEvent } from "@quickdrop/spine";
import type { LifecycleStage, LoyaltyTier } from "@quickdrop/shared";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  computeAvgOrderAmount,
  computeLifecycle,
  computeRfm,
  computeTier,
  topFavorites,
  type BrainInputs,
  type BrainThresholds,
  type FavoriteItem,
  DEFAULT_THRESHOLDS,
} from "./compute.js";

// دمج WaFlow (MERGE_PLAN §3.3) — إعادة حساب دماغ الزبون داخل ترانزاكشن مستأجر قائمة:
// المصدر orders (لا أعمدة عدّاد مبعثرة كما بـ WaFlow)، والكتابة كاش على customer_profiles
// + loyalty_accounts.tier (الدماغ المالك الوحيد للمستوى — recalc-tiers يتقاعد §critic-24).
// عند تغيّر المرحلة يُنشَر crm.lifecycle_changed على الـ spine بنفس الترانزاكشن (D9).
// تُستدعى من مستهلكي الـ spine (order.delivered/payment.paid) والكنس الليلي.

const MS_PER_DAY = 86_400_000;

export interface RecomputeResult {
  userId: string;
  orderCount: number;
  totalSpent: bigint;
  rfm: number;
  tier: LoyaltyTier;
  stage: LifecycleStage;
  stageChanged: boolean;
}

export async function recomputeCustomerBrain(
  tx: Tx,
  tenantId: string,
  userId: string,
  opts: { now?: Date; thresholds?: BrainThresholds } = {},
): Promise<RecomputeResult> {
  const now = opts.now ?? new Date(); // D6: UTC
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;

  // (1) مجاميع الطلبات المُسلَّمة — استعلام واحد (لا N+1). المُنفَق = بضاعة + توصيل
  // (ما دفعه الزبون، ثابت بصرف النظر عن طريقة الدفع؛ cod_amount يُصفَّر عند الدفع الإلكتروني).
  const agg = await tx
    .select({
      orderCount: sql<number>`count(*)::int`,
      totalSpent: sql<string>`coalesce(sum(${orders.goodsAmount} + ${orders.priceTotal}), 0)::text`,
      // ::text كي يعود نصاً حتمياً (تعبير sql خام لا يُمرَّر لمحوّل نوع Date)
      lastOrderAt: sql<string | null>`max(${orders.deliveredAt})::text`,
    })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.customerId, userId), eq(orders.status, "delivered")));
  const row = agg[0] ?? { orderCount: 0, totalSpent: "0", lastOrderAt: null };
  const orderCount = row.orderCount;
  const totalSpent = BigInt(row.totalSpent); // نص → BigInt (لا float على المال — D5)
  const lastOrderAt = row.lastOrderAt ? new Date(row.lastOrderAt) : null;
  const daysSinceLastOrder = lastOrderAt ? Math.floor((now.getTime() - lastOrderAt.getTime()) / MS_PER_DAY) : null;

  // (2) المرحلة السابقة (لحساب recovered) من الملف إن وُجد
  const prior = await tx
    .select({ stage: customerProfiles.lifecycleStage })
    .from(customerProfiles)
    .where(and(eq(customerProfiles.tenantId, tenantId), eq(customerProfiles.userId, userId)))
    .limit(1);
  const previousStage: LifecycleStage = prior[0]?.stage ?? "new";

  const inputs: BrainInputs = { orderCount, totalSpent, daysSinceLastOrder, previousStage };
  const rfm = computeRfm(inputs, thresholds);
  const stage = computeLifecycle(inputs);
  const tier = computeTier(inputs, rfm, thresholds);
  const avgOrderAmount = computeAvgOrderAmount(totalSpent, orderCount);

  // (3) المفضّلات — أعلى 3 catalog_item_id بمجموع الكمية عبر آخر الطلبات غير الملغاة
  const favRows = await tx
    .select({ catalogItemId: orderItems.catalogItemId, qty: sql<number>`sum(${orderItems.qty})::int` })
    .from(orderItems)
    .innerJoin(orders, and(eq(orderItems.tenantId, orders.tenantId), eq(orderItems.orderId, orders.id)))
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        eq(orders.customerId, userId),
        eq(orders.status, "delivered"),
        isNotNull(orderItems.catalogItemId),
      ),
    )
    .groupBy(orderItems.catalogItemId);
  const favorites: FavoriteItem[] = topFavorites(
    favRows.filter((f): f is { catalogItemId: string; qty: number } => f.catalogItemId !== null),
  );

  const churnRiskAt = stage === "at_risk" ? now : null;

  // (4) upsert الملف (كاش مُعلَن) — منشئه إن غاب، وإلا تحديث
  await tx
    .insert(customerProfiles)
    .values({
      tenantId,
      userId,
      lifecycleStage: stage,
      rfmScore: rfm,
      orderCount,
      totalSpent,
      avgOrderAmount,
      lastOrderAt,
      favoriteItems: favorites,
      churnRiskAt,
      brainComputedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [customerProfiles.tenantId, customerProfiles.userId],
      set: {
        lifecycleStage: stage,
        rfmScore: rfm,
        orderCount,
        totalSpent,
        avgOrderAmount,
        lastOrderAt,
        favoriteItems: favorites,
        churnRiskAt,
        brainComputedAt: now,
        updatedAt: now,
      },
    });

  // (5) المستوى على loyalty_accounts (الدماغ المالك الوحيد — recalc-tiers متقاعد)
  await tx
    .insert(loyaltyAccounts)
    .values({ tenantId, userId, tier, tierCalculatedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [loyaltyAccounts.tenantId, loyaltyAccounts.userId],
      set: { tier, tierCalculatedAt: now, updatedAt: now },
    });

  // (6) حدث الـ spine عند تغيّر المرحلة (نفس الترانزاكشن — D9)
  const stageChanged = stage !== previousStage;
  if (stageChanged) {
    await publishSpineEvent(tx, tenantId, "crm.lifecycle_changed", { userId, from: previousStage, to: stage });
  }

  return { userId, orderCount, totalSpent, rfm, tier, stage, stageChanged };
}
