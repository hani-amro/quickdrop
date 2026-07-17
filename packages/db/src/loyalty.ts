import { and, eq, gte, ne, sql } from "drizzle-orm";
import {
  couponRedemptions,
  loyaltyAccounts,
  loyaltyEvents,
  orders,
  referrals,
  tenants,
  type Order,
} from "./schema/index.js";
import type { Tx } from "./with-tenant.js";

// §9 v1.1 — الولاء: النقاط والمحفظة قيود بـ loyalty_events والرصيد مجموع (نفس فلسفة
// الدفتر §8.1). كل منح يحدث عند delivered فقط. تُستدعى هذه الدوال من transition()
// داخل ترانزاكشن الانتقال — ذرّية مع تغيّر الحالة.

/** §9 — رصيد الولاء = SUM على القيود؛ لا أعمدة رصيد تتعفّن. للعرض وللاسترداد. */
export async function loyaltyBalance(
  tx: Tx,
  tenantId: string,
  userId: string,
): Promise<{ points: number; wallet: bigint }> {
  const rows = await tx
    .select({
      points: sql<number>`COALESCE(SUM(${loyaltyEvents.deltaPoints}), 0)::int`,
      wallet: sql<string>`COALESCE(SUM(${loyaltyEvents.deltaWallet}), 0)::text`,
    })
    .from(loyaltyEvents)
    .where(and(eq(loyaltyEvents.tenantId, tenantId), eq(loyaltyEvents.userId, userId)));
  const row = rows[0];
  return { points: row?.points ?? 0, wallet: BigInt(row?.wallet ?? "0") };
}

/**
 * §9 v1.1 — عند delivered: منح نقاط الطلب للزبون، وإتمام أول إحالة له إن وُجدت
 * (pending → earned مع مكافأة للمُحيل، ضمن سقف شهري — منع مزارع الإحالات).
 * تضمن حساب ولاء واحد للزبون (idempotent على الحساب).
 */
export async function applyDeliveryLoyalty(
  tx: Tx,
  order: Pick<Order, "id" | "tenantId" | "customerId">,
  rates: Pick<
    typeof tenants.$inferSelect,
    "loyaltyPointsPerOrder" | "referralBonusPoints" | "referralMonthlyCap" | "timezone"
  >,
): Promise<void> {
  // ضمان صف حساب الولاء (مرساة القفل للاسترداد لاحقاً §9)
  await tx
    .insert(loyaltyAccounts)
    .values({ tenantId: order.tenantId, userId: order.customerId })
    .onConflictDoNothing({ target: [loyaltyAccounts.tenantId, loyaltyAccounts.userId] });

  // منح نقاط الطلب (reason 'order')
  if (rates.loyaltyPointsPerOrder > 0) {
    await tx.insert(loyaltyEvents).values({
      tenantId: order.tenantId,
      userId: order.customerId,
      deltaPoints: rates.loyaltyPointsPerOrder,
      reason: "order",
      orderId: order.id,
    });
  }

  // §9 — الإحالة: pending حتى يكتمل أول طلب للمدعو. هل هذا أول طلب delivered لهذا الزبون؟
  const priorDelivered = await tx
    .select({ one: sql`1` })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, order.tenantId),
        eq(orders.customerId, order.customerId),
        eq(orders.status, "delivered"),
        sql`${orders.id} <> ${order.id}`,
      ),
    )
    .limit(1);
  if (priorDelivered.length > 0) return; // ليس أول طلب — لا إحالة تُستحق

  // هل هذا الزبون مُحال (referee) بإحالة pending؟
  const pending = await tx
    .select({ id: referrals.id, referrerUserId: referrals.referrerUserId })
    .from(referrals)
    .where(
      and(
        eq(referrals.tenantId, order.tenantId),
        eq(referrals.refereeUserId, order.customerId),
        eq(referrals.status, "pending"),
      ),
    )
    .limit(1);
  const ref = pending[0];
  if (!ref) return;

  // §9 — إتمام ذرّي winner-take-all: القيد status='pending' + RETURNING يجعل ترانزاكشناً
  // واحداً فقط يكسب القلب pending→earned عند تسليمين متزامنين لنفس المدعو؛ الخاسر يجد
  // 0 صفوف بعد إعادة التقييم فيتخطّى المكافأة (كان بلا قيد → منح مزدوج، كُشف بالنبش).
  const claimed = await tx
    .update(referrals)
    .set({ status: "earned", earnedAt: new Date() })
    .where(and(eq(referrals.tenantId, order.tenantId), eq(referrals.id, ref.id), eq(referrals.status, "pending")))
    .returning({ id: referrals.id });
  if (claimed.length === 0) return; // خسر السباق — عُلّمت earned من الفائز، لا مكافأة ثانية
  if (rates.referralBonusPoints <= 0) return;

  // §9 — قفل حساب المُحيل: نقطة تسلسل واحدة لقرار السقف، فتتسلسل منحُ عدة مدعوّين متزامنين
  // لنفس المُحيل ويرى كلٌّ المجموع الملتزَم (كان بلا قفل → تجاوز السقف تحت التزامن).
  await tx
    .insert(loyaltyAccounts)
    .values({ tenantId: order.tenantId, userId: ref.referrerUserId })
    .onConflictDoNothing({ target: [loyaltyAccounts.tenantId, loyaltyAccounts.userId] });
  await tx
    .select({ id: loyaltyAccounts.id })
    .from(loyaltyAccounts)
    .where(and(eq(loyaltyAccounts.tenantId, order.tenantId), eq(loyaltyAccounts.userId, ref.referrerUserId)))
    .for("update");

  // §9/§16.8 — نافذة الشهر بمنطقة المستأجر لا منطقة جلسة القاعدة (تصحيح حدود الشهر).
  // نستثني الإحالة الحالية (عُلّمت earned للتو) كي يبقى العدّ = المُستحَق سابقاً هذا الشهر.
  const monthStart = sql`date_trunc('month', now() AT TIME ZONE ${rates.timezone}) AT TIME ZONE ${rates.timezone}`;
  const earnedThisMonth = await tx
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(referrals)
    .where(
      and(
        eq(referrals.tenantId, order.tenantId),
        eq(referrals.referrerUserId, ref.referrerUserId),
        eq(referrals.status, "earned"),
        gte(referrals.earnedAt, monthStart),
        ne(referrals.id, ref.id),
      ),
    );
  const already = earnedThisMonth[0]?.n ?? 0;

  if (already < rates.referralMonthlyCap) {
    await tx.insert(loyaltyEvents).values({
      tenantId: order.tenantId,
      userId: ref.referrerUserId,
      deltaPoints: rates.referralBonusPoints,
      reason: "referral",
      orderId: order.id,
    });
  }
}

/**
 * §8.3-4 v1.1 — تسوية حجز الكوبون عند نهاية الطلب: delivered → consumed،
 * أي إلغاء/فشل → released (يعيد الاستخدام للمخزون). idempotent: يعمل فقط على reserved.
 */
export async function settleCouponOnTerminal(
  tx: Tx,
  tenantId: string,
  orderId: string,
  outcome: "consumed" | "released",
): Promise<void> {
  await tx
    .update(couponRedemptions)
    .set({ status: outcome, updatedAt: new Date() })
    .where(
      and(
        eq(couponRedemptions.tenantId, tenantId),
        eq(couponRedemptions.orderId, orderId),
        eq(couponRedemptions.status, "reserved"),
      ),
    );
}
