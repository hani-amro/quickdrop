import { sql } from "drizzle-orm";
import {
  COUPON_KINDS,
  LOYALTY_REASONS,
  LOYALTY_TIERS,
  REDEMPTION_STATUSES,
  REFERRAL_STATUSES,
} from "@quickdrop/shared";
import {
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idPk, money, tenantId, timestamptz, updatedAt } from "./_common.js";
import { users } from "./users.js";

// §9 v1.1 — loyalty_accounts: لا أعمدة رصيد (نفس فلسفة الدفتر §8.1) —
// النقاط والمحفظة = SUM من loyalty_events؛ الصف مرساة قفل (FOR UPDATE) لعمليات الاسترداد.
export const loyaltyAccounts = pgTable(
  "loyalty_accounts",
  {
    id: idPk(),
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(),
    tier: text("tier", { enum: LOYALTY_TIERS }).notNull().default("bronze"),
    tierCalculatedAt: timestamptz("tier_calculated_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("loyalty_accounts_tenant_id_id_uq").on(t.tenantId, t.id), // أب لمفاتيح مركّبة
    uniqueIndex("loyalty_accounts_tenant_user_uq").on(t.tenantId, t.userId), // حساب واحد لكل مستخدم
    foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id], name: "loyalty_accounts_user_fk" }),
  ],
);

// §9 v1.1 — loyalty_events: دفتر الولاء، append-only (لا updated_at).
export const loyaltyEvents = pgTable(
  "loyalty_events",
  {
    id: idPk(),
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(),
    deltaPoints: integer("delta_points").notNull().default(0),
    deltaWallet: money("delta_wallet").notNull().default(sql`0`), // D5: مال BIGINT
    reason: text("reason", { enum: LOYALTY_REASONS }).notNull(),
    orderId: uuid("order_id"), // بلا FK إلى orders لتفادي حلقة استيراد (orders يستورد coupons من هنا)
    createdAt: createdAt(),
  },
  (t) => [
    index("loyalty_events_tenant_user_created_idx").on(t.tenantId, t.userId, t.createdAt), // §2.3
    foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id], name: "loyalty_events_user_fk" }),
  ],
);

// §3 v1.1 — coupons: القيم المالية BIGINT (D5)؛ min_order_total NOT NULL DEFAULT 0 (8.3-1).
export const coupons = pgTable(
  "coupons",
  {
    id: idPk(),
    tenantId: tenantId(),
    code: text("code").notNull(),
    kind: text("kind", { enum: COUPON_KINDS }).notNull(),
    value: money("value").notNull(), // percent: نقاط أساس؛ fixed: أصغر وحدة
    maxUses: integer("max_uses"),
    maxUsesPerUser: integer("max_uses_per_user"),
    minOrderTotal: money("min_order_total").notNull().default(sql`0`),
    validFrom: timestamptz("valid_from"),
    validTo: timestamptz("valid_to"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("coupons_tenant_id_id_uq").on(t.tenantId, t.id), // أب لمفاتيح مركّبة (orders.coupon_id)
    uniqueIndex("coupons_tenant_code_uq").on(t.tenantId, t.code),
  ],
);

// §8.3-4 v1.1 — coupon_redemptions: حجز (reserved) عند تأكيد الطلب، استهلاك (consumed)
// عند delivered، تحرير (released) عند الإلغاء/الفشل؛ نسخة modified ترث حجز الأصل
// (لا حرق استخدام ثانٍ)؛ العدّ والفرض من هنا — لا قفل صف الكوبون (عنق زجاجة ببث رمضاني).
export const couponRedemptions = pgTable(
  "coupon_redemptions",
  {
    id: idPk(),
    tenantId: tenantId(),
    couponId: uuid("coupon_id").notNull(),
    userId: uuid("user_id").notNull(),
    orderId: uuid("order_id").notNull(), // بلا FK إلى orders لتفادي حلقة استيراد — الفرض بفحص CI مستقبلاً
    status: text("status", { enum: REDEMPTION_STATUSES }).notNull().default("reserved"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("coupon_redemptions_tenant_order_uq").on(t.tenantId, t.orderId), // حجز واحد لكل طلب
    index("coupon_redemptions_tenant_coupon_user_idx").on(t.tenantId, t.couponId, t.userId), // فرض max_uses_per_user
    foreignKey({ columns: [t.tenantId, t.couponId], foreignColumns: [coupons.tenantId, coupons.id], name: "coupon_redemptions_coupon_fk" }),
    foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id], name: "coupon_redemptions_user_fk" }),
  ],
);

// §3 v1.1 — referrals: pending حتى يكتمل أول طلب للمدعو؛ المكافأة بدفتر الولاء حصراً (§8.1).
export const referrals = pgTable(
  "referrals",
  {
    id: idPk(),
    tenantId: tenantId(),
    referrerUserId: uuid("referrer_user_id").notNull(),
    refereeUserId: uuid("referee_user_id").notNull(),
    status: text("status", { enum: REFERRAL_STATUSES }).notNull().default("pending"),
    earnedAt: timestamptz("earned_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("referrals_tenant_referee_uq").on(t.tenantId, t.refereeUserId), // المدعو يُحال مرة واحدة
    foreignKey({ columns: [t.tenantId, t.referrerUserId], foreignColumns: [users.tenantId, users.id], name: "referrals_referrer_fk" }),
    foreignKey({ columns: [t.tenantId, t.refereeUserId], foreignColumns: [users.tenantId, users.id], name: "referrals_referee_fk" }),
  ],
);

export type LoyaltyAccount = typeof loyaltyAccounts.$inferSelect;
export type LoyaltyEvent = typeof loyaltyEvents.$inferSelect;
export type NewLoyaltyEvent = typeof loyaltyEvents.$inferInsert;
export type Coupon = typeof coupons.$inferSelect;
export type NewCoupon = typeof coupons.$inferInsert;
export type CouponRedemption = typeof couponRedemptions.$inferSelect;
export type Referral = typeof referrals.$inferSelect;
