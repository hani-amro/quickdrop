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
// يبقى بعد ضياع Redis، وjobId حتمي = 'sched-{orderId}' يزيل تكرار at-least-once ويجعل
// إعادةَ جدولة الـ worker عند الإقلاع idempotentة مع مهمة الـ api الأصلية.
export const SCHEDULED_QUEUE = "scheduled";

export interface ScheduledOrderJob {
  tenantId: string;
  orderId: string;
}

/**
 * jobId الحتمي لمهمة الطلب المجدّل — يجب أن يكون **مصدراً واحداً** يستورده الـ api
 * (منتج المهمة) والـ worker (معيد الجدولة عند الإقلاع) كي لا يتباعدا فتنكسر الـ
 * idempotency. **BullMQ يمنع ':' في custom jobId** (محجوز لمفاتيح Redis الداخلية،
 * يرمي "Custom Id cannot contain :") — لذا الفاصل '-' لا ':'.
 */
export function scheduledJobId(orderId: string): string {
  return `sched-${orderId}`;
}

/**
 * jobId حتمي لتحديث تيليغرام — مصدر واحد للـ api (المنتج) والـ worker (rescan).
 * BullMQ يمنع ':' بالـ custom jobId — الفاصل '-' (uuid وupdate_id بلا شرطات ملتبسة).
 */
export function tgUpdateJobId(tenantId: string, updateId: number): string {
  return `tg-${tenantId}-${updateId}`;
}

// ——— دمج WaFlow (MERGE_PLAN §3.1) — طابور تحديثات واتساب: مرآة tg-updates ———
// البوابة تحفظ الحدث بجدول wa_webhook_updates (durable) ثم ترد 200 ثم تدفع المهمة؛
// المهمة تحمل معرّف صف الـ inbox فقط — الحمولة تُقرأ من القاعدة (مصدر الحقيقة §12).
export const WA_UPDATES_QUEUE = "wa-updates";

export interface WaUpdateJob {
  tenantId: string;
  /** uuid صف wa_webhook_updates */
  updateId: string;
}

/** jobId حتمي (بلا ':' — قيد BullMQ) — واحد للمنتج والـ rescan. */
export function waUpdateJobId(updateId: string): string {
  return `wa-${updateId}`;
}

// ——— دمج WaFlow (MERGE_PLAN §3.3/§3.4) — طابور أحداث الدماغ/الأتمتة ———
// نمط fan-out: عامل التقاط الـ outbox يدفع الصفوف ذات المواضيع المهمّة هنا (إضافةً
// لطابور الإشعارات)، فيستهلكها دماغ الزبون (وjourneys لاحقاً) باستقلال retry عن
// الإشعارات. jobId = outbox.id (نفس مفتاح إزالة التكرار §12). المستهلك idempotent.
export const BRAIN_QUEUE = "brain";

/** المواضيع التي تُدفَع لطابور الدماغ/الأتمتة (الدماغ + تسجيل الرحلات يرشّحان داخلها). */
export const BRAIN_TOPICS: ReadonlySet<string> = new Set([
  "order.status_changed",
  "payment.paid",
  "crm.lifecycle_changed",
  "contact.created",
]);

/** jobId حتمي لمهمة الدماغ (بلا ':' — قيد BullMQ) — نفس معرّف صف الـ outbox. */
export function brainJobId(outboxId: string): string {
  return `brain-${outboxId}`;
}

// ——— دمج WaFlow (MERGE_PLAN §3.4) — طابور تنفيذ خطوات الرحلات (delayed jobs) ———
// التسجيل (بالـ brain-queue على أحداث spine) يجدول مهمة مؤجّلة عند next_run_at لكل run؛
// تنفيذ الخطوة يجدول التالية أو ينهي. القاعدة مصدر الحقيقة (§12) — rescan عند الإقلاع.
export const JOURNEYS_QUEUE = "journeys";

export interface JourneyStepJob {
  tenantId: string;
  runId: string;
  /** رقم الخطوة المقصود بهذه المهمة — يحرس ضد انهيار التأخير عند إعادة التسليم:
   *  المنفّذ لا ينفّذ إلا إن كان current_step في القاعدة == step (وإلا مهمة قديمة، no-op). */
  step: number;
}

/** jobId حتمي لخطوة رحلة (بلا ':' — قيد BullMQ) — (run, step) كي تتقدّم الجدولة idempotent. */
export function journeyStepJobId(runId: string, step: number): string {
  return `jrs-${runId}-${step}`;
}
