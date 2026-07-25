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
  // دمج WaFlow (MERGE_PLAN §4.2) — حالتا المطبخ (طلبات food حصراً، حارس service بـ transition)
  "preparing",
  "ready",
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

// دمج WaFlow (§4.2 D-M6) — merchant فاعل مستقل: قبول التاجر = transition(confirmed→preparing)
export const ORDER_ACTOR_TYPES = ["customer", "driver", "staff", "system", "merchant"] as const;
export type OrderActorType = (typeof ORDER_ACTOR_TYPES)[number];

// دمج WaFlow (MERGE_PLAN §4.1/§4.2) — طلبات بلا رحلة توصيل (استلام ذاتي من المطعم):
// pickup لا يصل الإسناد أبداً (adversary #2) — حارس fulfillment بكل مواقع الإسناد.
export const FULFILLMENTS = ["delivery", "pickup"] as const;
export type Fulfillment = (typeof FULFILLMENTS)[number];

// §4.1 — أعمدة الدفع أعمدة عادية لا حالات (payment_status ليس بآلة الحالة أبداً).
// حارس رتيب: UPDATE ... WHERE payment_status <> 'paid' (إعادات Billplz لا تُرجِع مدفوعاً).
export const PAYMENT_STATUSES = ["unpaid", "paid"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

// §4.2.3 — الحالات القابلة للإسناد: مدخل الإسناد confirmed|preparing|ready → assigned.
// الإسناد يبدأ حصراً باستهلاك order.ready_for_dispatch (الفاصل D8) — هذه المجموعة تحرس
// مواقع الإسناد الأربعة بـ dispatch.ts (كانت hard-coded على 'confirmed' — adversary #1).
export const DISPATCHABLE_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>(["confirmed", "preparing", "ready"]);

// §4.2.3 — توقيت seam الطعام لكل مستأجر: 'ready' (افتراضي — عند جهوز المطبخ) أو
// 'confirmed' (مطاعم تريد السائق ينطلق مع بدء التحضير). parcel/p2p دوماً عند confirmed.
export const DISPATCH_TRIGGERS = ["ready", "confirmed"] as const;
export type DispatchTrigger = (typeof DISPATCH_TRIGGERS)[number];

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

// ——— دمج WaFlow (MERGE_PLAN §4.4) — صندوق المحادثات الموحّد (مخزن واحد، قرار المالك
// 2026-07-19): نفس الزبون = خيط واحد مهما تعدّدت القنوات؛ القناة سمة الرسالة لا مخزن. ———
export const CONVERSATION_STATUSES = ["open", "pending", "resolved", "snoozed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_CHANNELS = ["whatsapp", "telegram"] as const; // instagram/facebook مؤجّلة
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const MESSAGE_TYPES = [
  "text", "image", "video", "audio", "document", "sticker", "location", "interactive", "template", "reaction",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const MESSAGE_STATUSES = ["sent", "delivered", "read", "failed"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

// ——— دمج WaFlow (MERGE_PLAN §3.4) — Journeys: محرك الأتمتة الوحيد ———
// حالة تسجيل الزبون بالرحلة (WaFlow استخدم نصاً؛ عندنا enum مضبوط).
export const JOURNEY_RUN_STATUSES = ["active", "completed", "cancelled"] as const;
export type JourneyRunStatus = (typeof JOURNEY_RUN_STATUSES)[number];

// أنواع خطوات الرحلة (WaFlow: send_message|ai_handoff|add_tag|wait).
export const JOURNEY_STEP_TYPES = ["send_message", "ai_handoff", "add_tag", "wait"] as const;
export type JourneyStepType = (typeof JOURNEY_STEP_TYPES)[number];

// مُطلِّقات الرحلة المسموحة = المواضيع التي يخرّطها منفّذ التسجيل (journeyTriggerFor).
// أي مُطلِّق خارجها لا يُسجّل أبداً، فيُرفض عند الإنشاء (§11) لا أن يُخزَّن ميتاً.
export const JOURNEY_TRIGGERS = ["contact.created", "order.delivered", "payment.paid", "crm.lifecycle_changed"] as const;
export type JourneyTrigger = (typeof JOURNEY_TRIGGERS)[number];

// ——— Task A (D1) — نافذة واتساب 24 ساعة + قوالب HSM (كله additive عند حدّ الإرسال) ———
// فئة الرسالة الصادرة تحدّد سلوك النافذة: service_reply = ردّ داخل محادثة (داخل النافذة
// بحكم أنّ الزبون راسل توّاً — يُرسَل حرّاً)؛ notification = تحديث حالة/إيصال قد يُطلَق أيّ
// وقت (خارج النافذة يجب قالب HSM معتمد، وإلا degraded — لا إسقاط صامت).
export const WA_SEND_CATEGORIES = ["service_reply", "notification"] as const;
export type WaSendCategory = (typeof WA_SEND_CATEGORIES)[number];

// المفاتيح الداخلية للإشعارات → قوالب Meta (الربط فقط؛ نصوص القوالب تُسجَّل عند Meta).
export const WA_TEMPLATE_KEYS = [
  "order_confirmed",
  "order_dispatched",
  "driver_arriving",
  "order_delivered",
  "payment_receipt",
] as const;
export type WaTemplateKey = (typeof WA_TEMPLATE_KEYS)[number];

// حالة اعتماد القالب لدى Meta (لا نرسل إلا approved).
export const WA_TEMPLATE_STATUSES = ["approved", "pending", "rejected"] as const;
export type WaTemplateStatus = (typeof WA_TEMPLATE_STATUSES)[number];

// سجلّ تسليم واتساب لكل صفّ outbox (مفتاح exactly-once + سجلّ النتيجة المرئي):
// mode = كيف أُرسِلت (حرّ/قالب) أو أنها تعذّرت (degraded)؛ status = طور الادّعاء/النتيجة.
export const WA_DELIVERY_MODES = ["free_form", "template", "degraded"] as const;
export type WaDeliveryMode = (typeof WA_DELIVERY_MODES)[number];

export const WA_DELIVERY_STATUSES = ["claimed", "sent", "degraded"] as const;
export type WaDeliveryStatus = (typeof WA_DELIVERY_STATUSES)[number];
