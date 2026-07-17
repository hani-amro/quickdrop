// أسماء الطوابير — ثابت مشترك: المنتج (api) والمستهلك (worker) يقرآن من هنا.
export const TG_UPDATES_QUEUE = "tg-updates";

export interface TgUpdateJob {
  tenantId: string;
  updateId: number;
}

// D9/§12 — طابور الإشعارات: عامل التقاط الـ outbox يدفع الصفوف الملتقطة هنا،
// والمرسل الفعلي (تيليغرام لاحقاً) يستهلكها بعد الالتزام. التسليم at-least-once —
// كل مستهلك idempotent بمفتاح إزالة تكرار = outboxId (= outbox.id).
export const NOTIFICATIONS_QUEUE = "notifications";

export interface NotificationJob {
  outboxId: string;
  tenantId: string;
  topic: string;
  payload: Record<string, unknown>;
}

// §6 — محرك الإسناد: مهمتان بطابور واحد.
// dispatch-order: ابدأ/وسّع جولة. offer-timeout: delayed job عند offers.expires_at —
// مصدر الحقيقة للمهلة هو العمود، والمعالج يقفل ويفحص قبل أي فعل (§6.2 D16).
export const DISPATCH_QUEUE = "dispatch";

export interface DispatchOrderJob {
  kind: "dispatch-order";
  tenantId: string;
  orderId: string;
  round: number;
}

export interface OfferTimeoutJob {
  kind: "offer-timeout";
  tenantId: string;
  offerId: string;
}

export type DispatchJob = DispatchOrderJob | OfferTimeoutJob;

/** §6.2 — مهلة العرض بالمللي ثانية (45 ثانية). */
export const OFFER_TTL_MS = 45_000;

/** §6.2 — بعد كم جولة فاشلة يتنبّه الموزّع بدل الدوران الصامت. */
export const MAX_DISPATCH_ROUNDS = 3;

// §4.3/§14 — طابور البث الجماهيري: الـ api يدفع مهمة واحدة لكل بثّة (فوراً إن غير
// مجدولة)، والـ worker يجلب الجمهور ويرسل رسالة لكل مستخدم مع احترام حدّ المعدل
// (~30 msg/s لكل بوت §4.3). مهمة واحدة لكل بثّة (لا مهمة لكل مستخدم) — التقدّم
// يُسجَّل بعدّادات broadcasts، وjobId حتمي = broadcastId يزيل تكرار at-least-once.
export const BROADCAST_QUEUE = "broadcast";

export interface BroadcastJob {
  tenantId: string;
  broadcastId: string;
}

// §6.3 — طابور الطلبات المجدولة: الـ api يدفع مهمة مؤجّلة عند إنشاء طلب بموعد مستقبلي
// (delay = scheduled_at − الآن)، والـ worker يستهلكها عند الموعد فيطلق الطلب
// scheduled→pending بفاعل system. القاعدة مصدر الحقيقة لا الطابور (§12): orders.scheduled_at
// يبقى بعد ضياع Redis، وjobId حتمي = 'sched:{orderId}' يزيل تكرار at-least-once ويجعل
// إعادةَ جدولة الـ worker عند الإقلاع idempotentة مع مهمة الـ api الأصلية.
export const SCHEDULED_QUEUE = "scheduled";

export interface ScheduledOrderJob {
  tenantId: string;
  orderId: string;
}
