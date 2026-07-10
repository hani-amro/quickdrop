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
