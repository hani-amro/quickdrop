// ثوابت الحالات — مصدر الحقيقة الوحيد للأنواع العابرة للتطبيقات (القسم 1).

export const TENANT_STATUSES = ["trial", "active", "past_due", "suspended", "churned"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const TENANT_PLANS = ["starter", "growth", "pro"] as const;
export type TenantPlan = (typeof TENANT_PLANS)[number];

// §5: آلة حالة الطلب (جدول الانتقالات الكامل يُبنى بالمرحلة 1 — الأنواع من الآن).
export const ORDER_STATUSES = [
  "draft",
  "scheduled",
  "pending",
  "confirmed",
  "assigned",
  "picked_up",
  "in_transit",
  "arrived",
  "delivered",
  "cancelled_by_customer",
  "cancelled_by_office",
  "failed",
  "returned",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const WEBHOOK_UPDATE_STATUSES = ["received", "processed"] as const;
export type WebhookUpdateStatus = (typeof WEBHOOK_UPDATE_STATUSES)[number];

// —— enums نموذج البيانات §3 (v1.1) ——

export const SERVICES = ["food", "parcel", "p2p"] as const;
export type Service = (typeof SERVICES)[number];

export const USER_ROLES = ["customer", "driver", "staff"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const VEHICLES = ["bike", "motorbike", "car"] as const;
export type Vehicle = (typeof VEHICLES)[number];

// D14: لا حالة busy — الانشغال يُشتق من عدد الطلبات النشطة
export const DRIVER_STATUSES = ["offline", "online"] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];

export const MERCHANT_CATEGORIES = ["restaurant", "shop"] as const;
export type MerchantCategory = (typeof MERCHANT_CATEGORIES)[number];

export const ORDER_ACTOR_TYPES = ["customer", "driver", "staff", "system"] as const;
export type OrderActorType = (typeof ORDER_ACTOR_TYPES)[number];

export const OFFER_STATUSES = ["pending", "accepted", "rejected", "expired"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const ATTACHMENT_KINDS = ["pod_photo", "signature"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

// §8.1 v1.1 — المنظور: موجب = بذمة السائق للمكتب؛ إشارة كل نوع مفروضة بـ CHECK
export const LEDGER_ENTRY_TYPES = [
  "cod_collected",
  "goods_paid_by_driver",
  "delivery_fee_earned",
  "remitted",
  "payout",
  "adjustment",
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export const SETTLEMENT_STATUSES = ["open", "closed"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const LOYALTY_TIERS = ["bronze", "silver", "gold"] as const;
export type LoyaltyTier = (typeof LOYALTY_TIERS)[number];

export const LOYALTY_REASONS = ["order", "referral", "compensation", "redeem", "expiry"] as const;
export type LoyaltyReason = (typeof LOYALTY_REASONS)[number];

export const COUPON_KINDS = ["percent", "fixed", "free_delivery"] as const;
export type CouponKind = (typeof COUPON_KINDS)[number];

export const REDEMPTION_STATUSES = ["reserved", "consumed", "released"] as const;
export type RedemptionStatus = (typeof REDEMPTION_STATUSES)[number];

export const REFERRAL_STATUSES = ["pending", "earned"] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export const SUPPORT_THREAD_STATUSES = ["open", "closed"] as const;
export type SupportThreadStatus = (typeof SUPPORT_THREAD_STATUSES)[number];

export const MESSAGE_DIRECTIONS = ["in", "out"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const BROADCAST_STATUSES = ["draft", "scheduled", "sending", "done", "failed"] as const;
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

export const STAFF_ROLES = ["owner", "dispatcher", "accountant", "support"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const OUTBOX_STATUSES = ["pending", "sent", "failed"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

// ——— دمج WaFlow (MERGE_PLAN §4.3) — دماغ الزبون (CRM) ———
export const LIFECYCLE_STAGES = ["new", "active", "loyal", "at_risk", "churned", "recovered"] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const CUSTOMER_FACT_SOURCES = ["ai", "manual", "system"] as const;
export type CustomerFactSource = (typeof CUSTOMER_FACT_SOURCES)[number];
