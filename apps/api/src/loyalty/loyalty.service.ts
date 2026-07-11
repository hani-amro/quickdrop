import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  couponRedemptions,
  coupons,
  loyaltyAccounts,
  loyaltyBalance,
  loyaltyEvents,
  referrals,
  users,
  withTenant,
  type DbHandle,
} from "@quickdrop/db";
import {
  COUPON_KINDS,
  type CouponKind,
  type LoyaltyReason,
  type LoyaltyTier,
  type ReferralStatus,
} from "@quickdrop/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { DB, ENV } from "../app.module.js";
import {
  assertStaffToken,
  parseOr400,
  resolveActiveTenant,
  slugSchema,
  uuidSchema,
} from "../common/staff-http.js";
import type { ApiEnv } from "../env.js";

// §9 v1.1 — REST الولاء والكوبونات والإحالات للداشبورد. نفس نمط orders/drivers:
// التخويل المؤقت (Bearer STAFF_API_TOKEN §10.2 لاحقاً)، Zod على كل مدخل (§11)،
// bigint→string عند الحافة (D5)، والوصول للقاعدة عبر withTenant حصراً (§2.2).

// D5 — المال بالـ JSON سلسلة أرقام عشرية (bigint↔string عند الحافة؛ لا أرقام JSON للمال)
const moneyStringSchema = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform((s) => BigInt(s));

// كود الكوبون: حروف/أرقام/شرطة — يُطابَق حرفياً (فريد ضمن المستأجر)
const couponCodeSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{2,40}$/);

// D6 — ISO 8601 بإزاحة صريحة؛ يُخزَّن UTC
const datetimeSchema = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));

const balanceQuerySchema = z.object({ tenantSlug: slugSchema });

const listCouponsQuerySchema = z.object({ tenantSlug: slugSchema });

const createCouponBodySchema = z
  .object({
    tenantSlug: slugSchema,
    code: couponCodeSchema,
    kind: z.enum(COUPON_KINDS),
    value: moneyStringSchema, // percent: نقاط أساس؛ fixed: أصغر وحدة؛ free_delivery: مُتجاهَل
    maxUses: z.number().int().positive().max(1_000_000).optional(),
    maxUsesPerUser: z.number().int().positive().max(1_000_000).optional(),
    minOrderTotal: moneyStringSchema.optional(),
    validFrom: datetimeSchema.optional(),
    validTo: datetimeSchema.optional(),
  })
  // نافذة صلاحية متسقة: النهاية بعد البداية إن وُجدتا معاً
  .refine((b) => b.validFrom === undefined || b.validTo === undefined || b.validTo > b.validFrom, {
    message: "validTo must be after validFrom",
    path: ["validTo"],
  });

const createReferralBodySchema = z
  .object({
    tenantSlug: slugSchema,
    referrerUserId: uuidSchema,
    refereeUserId: uuidSchema,
  })
  // الزبون لا يُحيل نفسه (منع مزارع الإحالات §9)
  .refine((b) => b.referrerUserId !== b.refereeUserId, {
    message: "referrer and referee must differ",
    path: ["refereeUserId"],
  });

// —— أشكال الاستجابة (كل مال string — D5) ——

export interface LoyaltyEventView {
  id: string;
  deltaPoints: number;
  deltaWallet: string;
  reason: LoyaltyReason;
  orderId: string | null;
  createdAt: string;
}

export interface LoyaltyBalanceResponse {
  userId: string;
  tier: LoyaltyTier | null; // null = لا حساب ولاء بعد (لم يُسلَّم له طلب)
  points: number;
  wallet: string;
  events: LoyaltyEventView[];
}

export interface CouponView {
  id: string;
  code: string;
  kind: CouponKind;
  value: string;
  maxUses: number | null;
  maxUsesPerUser: number | null;
  minOrderTotal: string;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  usedCount: number; // reserved+consumed — الاستخدامات التي تشغل مخزون الكوبون (§8.3-4)
  createdAt: string;
}

export interface CreateCouponResponse {
  coupon: CouponView;
}

export interface ListCouponsResponse {
  coupons: CouponView[];
}

export interface CreateReferralResponse {
  referral: {
    id: string;
    referrerUserId: string;
    refereeUserId: string;
    status: ReferralStatus;
    createdAt: string;
  };
}

@Injectable()
export class LoyaltyService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  // §9 — GET /api/loyalty/:userId : الرصيد (SUM) + آخر 20 حدث ولاء + المستوى الحالي.
  async balance(authorization: string | undefined, userId: string, query: unknown): Promise<LoyaltyBalanceResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const id = parseOr400(uuidSchema, userId, "loyalty_balance_id");
    const input = parseOr400(balanceQuerySchema, query, "loyalty_balance");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);

    return withTenant(this.handle.db, tenant.id, async (tx) => {
      const { points, wallet } = await loyaltyBalance(tx, tenant.id, id);

      // المستوى من loyalty_accounts (يُحسب بـ cron ليلي §9) — null إن لا حساب بعد.
      const accountRows = await tx
        .select({ tier: loyaltyAccounts.tier })
        .from(loyaltyAccounts)
        .where(and(eq(loyaltyAccounts.tenantId, tenant.id), eq(loyaltyAccounts.userId, id)))
        .limit(1);

      // آخر 20 حدثاً — الأحدث أولاً؛ فهرس (tenant_id, user_id, created_at)
      const eventRows = await tx
        .select({
          id: loyaltyEvents.id,
          deltaPoints: loyaltyEvents.deltaPoints,
          deltaWallet: loyaltyEvents.deltaWallet,
          reason: loyaltyEvents.reason,
          orderId: loyaltyEvents.orderId,
          createdAt: loyaltyEvents.createdAt,
        })
        .from(loyaltyEvents)
        .where(and(eq(loyaltyEvents.tenantId, tenant.id), eq(loyaltyEvents.userId, id)))
        .orderBy(desc(loyaltyEvents.createdAt))
        .limit(20);

      return {
        userId: id,
        tier: accountRows[0]?.tier ?? null,
        points,
        wallet: String(wallet), // D5: bigint→string عند الحافة
        events: eventRows.map((e) => ({
          id: e.id,
          deltaPoints: e.deltaPoints,
          deltaWallet: String(e.deltaWallet),
          reason: e.reason,
          orderId: e.orderId,
          createdAt: e.createdAt.toISOString(),
        })),
      };
    });
  }

  // §9 — POST /api/coupons : إنشاء كوبون. تعارض الكود (tenant_id, code) = 409.
  async createCoupon(authorization: string | undefined, body: unknown): Promise<CreateCouponResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(createCouponBodySchema, body, "coupons_create");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);

    const created = await withTenant(this.handle.db, tenant.id, async (tx) => {
      const inserted = await tx
        .insert(coupons)
        .values({
          tenantId: tenant.id,
          code: input.code,
          kind: input.kind,
          value: input.value,
          ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
          ...(input.maxUsesPerUser !== undefined ? { maxUsesPerUser: input.maxUsesPerUser } : {}),
          ...(input.minOrderTotal !== undefined ? { minOrderTotal: input.minOrderTotal } : {}),
          ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
          ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
        })
        // كود مكرر للمستأجر = تعارض عمل (لا باغ): لا تُدرِج، واكشفه بصف فارغ (§16.7)
        .onConflictDoNothing({ target: [coupons.tenantId, coupons.code] })
        .returning();
      return inserted[0];
    });

    if (!created) {
      throw new ConflictException("coupon code already exists");
    }

    // §13: لوغ منظّم بحقول ثابتة — بلا PII (الكود ليس سراً لكن نكتفي بالمعرّف)
    console.log(
      JSON.stringify({ action: "coupon_created", tenant_id: tenant.id, coupon_id: created.id, kind: created.kind }),
    );

    return {
      coupon: {
        id: created.id,
        code: created.code,
        kind: created.kind,
        value: String(created.value), // D5
        maxUses: created.maxUses,
        maxUsesPerUser: created.maxUsesPerUser,
        minOrderTotal: String(created.minOrderTotal),
        validFrom: created.validFrom?.toISOString() ?? null,
        validTo: created.validTo?.toISOString() ?? null,
        isActive: created.isActive,
        usedCount: 0, // كوبون جديد بلا حجوزات
        createdAt: created.createdAt.toISOString(),
      },
    };
  }

  // §9 — GET /api/coupons : قائمة الكوبونات + عدد الاستخدامات (§16.10: عدّ بـ subquery
  // مرتبط واحد، لا N+1). usedCount = reserved+consumed (المشغِّلة لمخزون max_uses §8.3-4).
  async listCoupons(authorization: string | undefined, query: unknown): Promise<ListCouponsResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(listCouponsQuerySchema, query, "coupons_list");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);

    const usedCountExpr = sql<number>`(
      SELECT count(*) FROM coupon_redemptions cr
       WHERE cr.tenant_id = ${coupons.tenantId}
         AND cr.coupon_id = ${coupons.id}
         AND cr.status IN ('reserved', 'consumed')
    )`.mapWith(Number);

    const rows = await withTenant(this.handle.db, tenant.id, (tx) =>
      tx
        .select({
          id: coupons.id,
          code: coupons.code,
          kind: coupons.kind,
          value: coupons.value,
          maxUses: coupons.maxUses,
          maxUsesPerUser: coupons.maxUsesPerUser,
          minOrderTotal: coupons.minOrderTotal,
          validFrom: coupons.validFrom,
          validTo: coupons.validTo,
          isActive: coupons.isActive,
          usedCount: usedCountExpr,
          createdAt: coupons.createdAt,
        })
        .from(coupons)
        .where(eq(coupons.tenantId, tenant.id))
        .orderBy(desc(coupons.createdAt))
        .limit(100), // §10.1 — ترقيم من الخادم؛ سقف v1
    );

    return {
      coupons: rows.map((r) => ({
        id: r.id,
        code: r.code,
        kind: r.kind,
        value: String(r.value), // D5
        maxUses: r.maxUses,
        maxUsesPerUser: r.maxUsesPerUser,
        minOrderTotal: String(r.minOrderTotal),
        validFrom: r.validFrom?.toISOString() ?? null,
        validTo: r.validTo?.toISOString() ?? null,
        isActive: r.isActive,
        usedCount: r.usedCount,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  // §9 — POST /api/referrals : إحالة pending. المدعو يُحال مرة واحدة (قيد فريد) = 409.
  async createReferral(authorization: string | undefined, body: unknown): Promise<CreateReferralResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(createReferralBodySchema, body, "referrals_create");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);

    const result = await withTenant(this.handle.db, tenant.id, async (tx) => {
      // كلا الطرفين لازم يكون مستخدماً بالمستأجر — قبل الإدراج نمنع خرق FK بصوت 500
      // ونعيده 404 حالة عمل (§11): استعلام واحد يعدّ الطرفين.
      const present = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.tenantId, tenant.id),
            inArray(users.id, [input.referrerUserId, input.refereeUserId]),
          ),
        );
      if (present.length < 2) {
        throw new NotFoundException("not found");
      }

      const inserted = await tx
        .insert(referrals)
        .values({
          tenantId: tenant.id,
          referrerUserId: input.referrerUserId,
          refereeUserId: input.refereeUserId,
          // status = pending افتراضياً — يُتمّه applyDeliveryLoyalty عند أول طلب للمدعو (§9)
        })
        // المدعو محال مسبقاً = تعارض عمل: لا تُدرِج، واكشفه بصف فارغ
        .onConflictDoNothing({ target: [referrals.tenantId, referrals.refereeUserId] })
        .returning();
      return inserted[0];
    });

    if (!result) {
      throw new ConflictException("المستخدم محال مسبقاً");
    }

    console.log(
      JSON.stringify({ action: "referral_created", tenant_id: tenant.id, referral_id: result.id }),
    );

    return {
      referral: {
        id: result.id,
        referrerUserId: result.referrerUserId,
        refereeUserId: result.refereeUserId,
        status: result.status,
        createdAt: result.createdAt.toISOString(),
      },
    };
  }
}
