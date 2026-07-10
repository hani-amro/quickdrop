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
