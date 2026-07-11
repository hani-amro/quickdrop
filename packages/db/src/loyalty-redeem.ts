import { and, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { loyaltyBalance } from "./loyalty.js";
import { loyaltyAccounts, loyaltyEvents } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";

// §9 v1.1 — استرداد رصيد المحفظة على طلب: حدث loyalty_events سالب (reason 'redeem').
// النقاط والمحفظة قيود والرصيد SUM (نفس فلسفة الدفتر §8.1) — التصحيح قيد جديد لا UPDATE.

/** المبلغ المطلوب استرداده يتجاوز رصيد المحفظة — سباق «نفس النقاط بطلبين» محسوم بالقفل. */
export class InsufficientBalanceError extends Error {
  readonly requested: bigint;
  readonly available: bigint;

  constructor(requested: bigint, available: bigint) {
    super(`insufficient loyalty wallet balance: requested ${requested}, available ${available}`);
    this.name = "InsufficientBalanceError";
    this.requested = requested;
    this.available = available;
  }
}

/**
 * §9 v1.1 — صرف مبلغ من محفظة الولاء على طلب. سباق «استخدام نفس النقاط بطلبين
 * متزامنين» حقيقي: القفل على صف loyalty_accounts (مرساة التسلسل) يجعل الطلب الثاني
 * ينتظر حتى يُلتزَم الأول، فيرى الرصيد المنقوص. الرصيد يُحسب SUM **داخل** نفس
 * الترانزاكشن بعد القفل (§9). الصرف = حدث redeem سالب على المحفظة + يُربَط بالطلب
 * (المستدعي يعكسه على price_discount للطلب).
 */
export async function redeemLoyaltyWallet(
  db: Db,
  tenantId: string,
  input: { userId: string; orderId: string; amount: bigint },
): Promise<{ points: number; wallet: bigint }> {
  if (input.amount <= 0n) {
    // §16.12: مبلغ استرداد غير موجب = استدعاء خاطئ يستحق صوتاً عالياً، لا حدث عبثي.
    throw new RangeError("redeemLoyaltyWallet: amount must be a positive bigint");
  }

  return withTenant(db, tenantId, async (tx) => {
    // §9: ضمان صف الحساب (مرساة القفل) — قد لا يوجد بعد إن لم يُسلَّم طلب للزبون.
    await tx
      .insert(loyaltyAccounts)
      .values({ tenantId, userId: input.userId })
      .onConflictDoNothing({ target: [loyaltyAccounts.tenantId, loyaltyAccounts.userId] });

    // §16.11 + §9: اقفل صف الحساب FOR UPDATE قبل حساب الرصيد — يسلسل الأطراف المتزامنة.
    await tx
      .select({ id: loyaltyAccounts.id })
      .from(loyaltyAccounts)
      .where(and(eq(loyaltyAccounts.tenantId, tenantId), eq(loyaltyAccounts.userId, input.userId)))
      .for("update");

    // الرصيد SUM داخل نفس الترانزاكشن (بعد القفل) — لا عمود رصيد يتعفّن (§9).
    const before = await loyaltyBalance(tx, tenantId, input.userId);
    if (input.amount > before.wallet) {
      throw new InsufficientBalanceError(input.amount, before.wallet);
    }

    // §9: append-only — الصرف حدث redeem سالب على المحفظة مربوط بالطلب.
    await tx.insert(loyaltyEvents).values({
      tenantId,
      userId: input.userId,
      deltaWallet: -input.amount,
      reason: "redeem",
      orderId: input.orderId,
    });

    return loyaltyBalance(tx, tenantId, input.userId);
  });
}
