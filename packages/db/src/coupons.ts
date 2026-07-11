import { computeCouponDiscount } from "@quickdrop/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { coupons, couponRedemptions } from "./schema/index.js";
import type { Tx } from "./with-tenant.js";

// §8.3-4 v1.1 — تطبيق الكوبون عند إنشاء الطلب: تحقّق + حجز (reserved) ضمن ترانزاكشن
// الإنشاء نفسها (لا حرق استخدام على طلب فاشل). الفرض عبر coupon_redemptions (عدّ
// reserved+consumed) **لا بقفل صف الكوبون** (§8.3-4: كوبون شعبي ببث رمضاني = كل
// الطلبات تتسلسل على صف واحد). صيغة الخصم الصافية من @quickdrop/shared (مصدر واحد).

// الحالات التي «تشغل» استخداماً من مخزون الكوبون: الحجز والاستهلاك؛ released لا يُعَدّ.
const REDEMPTION_ACTIVE_STATUSES = ["reserved", "consumed"] as const;

/** الكوبون غير موجود بالكود، أو غير مفعّل، أو خارج نافذة valid_from/valid_to. */
export class CouponInvalidError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`coupon "${code}" is invalid, inactive, or outside its validity window`);
    this.name = "CouponInvalidError";
    this.code = code;
  }
}

/** الكوبون استُنفد: تجاوز max_uses الكلي أو max_uses_per_user لهذا المستخدم. */
export class CouponExhaustedError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`coupon "${code}" has reached its usage limit`);
    this.name = "CouponExhaustedError";
    this.code = code;
  }
}

/** إجمالي الطلب دون الحد الأدنى min_order_total المطلوب لهذا الكوبون. */
export class CouponMinTotalError extends Error {
  readonly code: string;
  readonly minOrderTotal: bigint;

  constructor(code: string, minOrderTotal: bigint) {
    super(`coupon "${code}" requires a subtotal of at least ${minOrderTotal}`);
    this.name = "CouponMinTotalError";
    this.code = code;
    this.minOrderTotal = minOrderTotal;
  }
}

export interface ApplyCouponInput {
  couponCode: string;
  userId: string;
  orderId: string;
  /** إجمالي التوصيل قبل الخصم = quote.components.total (D5: bigint). */
  subtotal: bigint;
}

/**
 * §8.3-4 v1.1 — يتحقق من الكوبون ويحجزه (status reserved) ويرجع الخصم المحسوب.
 * تُستدعى داخل ترانزاكشن createOrder (§10.1) — الحجز ذرّي مع إدراج الطلب، فطلب
 * فاشل لا يحرق استخداماً. التسوية النهائية (consumed/released) بيد transition() عند
 * الحالة النهائية (§8.3-4 settleCouponOnTerminal).
 *
 * السباق «كوبونان متزامنان يتجاوزان max_uses»: مقبول بوعي (§8.3-4) — لا قفل صف
 * الكوبون (عنق زجاجة ببث رمضاني)؛ قيد (tenant_id, order_id) الفريد يمنع حجزين لطلب واحد.
 */
export async function applyCouponToOrder(
  tx: Tx,
  tenantId: string,
  input: ApplyCouponInput,
): Promise<{ couponId: string; discount: bigint }> {
  // §8.3-4: قراءة الكوبون بالكود بلا قفل صف (القرار المعماري) — الفرض بعدّ الحجوزات.
  const couponRows = await tx
    .select({
      id: coupons.id,
      kind: coupons.kind,
      value: coupons.value,
      maxUses: coupons.maxUses,
      maxUsesPerUser: coupons.maxUsesPerUser,
      minOrderTotal: coupons.minOrderTotal,
      validFrom: coupons.validFrom,
      validTo: coupons.validTo,
      isActive: coupons.isActive,
    })
    .from(coupons)
    .where(and(eq(coupons.tenantId, tenantId), eq(coupons.code, input.couponCode)))
    .limit(1);
  const coupon = couponRows[0];

  // §11/§16.12: كوبون غير موجود/معطّل/خارج النافذة = خطأ مصنّف صريح، لا خصم صامت.
  const now = new Date(); // D6: UTC
  if (
    !coupon ||
    !coupon.isActive ||
    (coupon.validFrom !== null && coupon.validFrom > now) ||
    (coupon.validTo !== null && coupon.validTo <= now)
  ) {
    throw new CouponInvalidError(input.couponCode);
  }

  // §8.3-1: الحد الأدنى للطلب — الإجمالي قبل الخصم يجب أن يبلغ min_order_total.
  if (input.subtotal < coupon.minOrderTotal) {
    throw new CouponMinTotalError(input.couponCode, coupon.minOrderTotal);
  }

  // §8.3-4: فرض السقوف بعدّ الحجوزات النشطة (reserved+consumed) — استعلام واحد
  // للإجمالي وللمستخدم معاً (فهرس coupon_redemptions_tenant_coupon_user_idx).
  const usageRows = await tx
    .select({
      total: sql<number>`COUNT(*)::int`,
      forUser: sql<number>`COUNT(*) FILTER (WHERE ${couponRedemptions.userId} = ${input.userId})::int`,
    })
    .from(couponRedemptions)
    .where(
      and(
        eq(couponRedemptions.tenantId, tenantId),
        eq(couponRedemptions.couponId, coupon.id),
        inArray(couponRedemptions.status, [...REDEMPTION_ACTIVE_STATUSES]),
      ),
    );
  const usage = usageRows[0] ?? { total: 0, forUser: 0 };
  if (coupon.maxUses !== null && usage.total >= coupon.maxUses) {
    throw new CouponExhaustedError(input.couponCode);
  }
  if (coupon.maxUsesPerUser !== null && usage.forUser >= coupon.maxUsesPerUser) {
    throw new CouponExhaustedError(input.couponCode);
  }

  // صيغة الخصم الصافية (مصدر واحد @quickdrop/shared) — القصّ لـ subtotal داخلها (8.3-4).
  const discount = computeCouponDiscount(coupon.kind, coupon.value, input.subtotal);

  // §8.3-4: الحجز reserved — يُستهلَك عند delivered أو يُحرَّر عند الإلغاء/الفشل (transition).
  await tx.insert(couponRedemptions).values({
    tenantId,
    couponId: coupon.id,
    userId: input.userId,
    orderId: input.orderId,
    status: "reserved",
  });

  return { couponId: coupon.id, discount };
}
