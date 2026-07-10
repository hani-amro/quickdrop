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
