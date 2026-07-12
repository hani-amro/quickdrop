// §13 المراقبة — أسماء مقاييس Prometheus وثوابت تسمياتها: مصدر حقيقة واحد يقرؤه
// الـ api (المنتِج/الكاشط) والـ worker (الطوابير) كي لا تنحرف الأسماء بينهما — نفس
// نمط queues.ts. نصّي صافٍ بلا اعتماد على prom-client: كل تطبيق يبني سجلّه بنفسه،
// وهذه الوحدة قابلة للاختبار كوحدة نقية (مساعدات التسميات أدناه).

export const METRIC_HTTP_REQUEST_DURATION = "quickdrop_http_request_duration_seconds";
export const METRIC_TELEGRAM_ERRORS = "quickdrop_telegram_errors_total";
export const METRIC_DISPATCH_DURATION = "quickdrop_dispatch_duration_seconds";
export const METRIC_QUEUE_DEPTH = "quickdrop_queue_depth";
export const METRIC_OSRM_REQUESTS = "quickdrop_osrm_requests_total";

// §13 — حالات عمق الطابور المرصودة: waiting للتنبيه على التراكم (> 500)، failed للـ
// DLQ (> 0)، وactive/delayed للتشخيص. أسماء حالات BullMQ حرفياً (getJobCounts).
export const QUEUE_DEPTH_STATES = ["waiting", "active", "delayed", "failed"] as const;
export type QueueDepthState = (typeof QUEUE_DEPTH_STATES)[number];

/**
 * §13 — تسمية مقياس زمن الطلب حسب المعالج: `Controller.handler` (مثلاً
 * `OrdersController.create`). ثابتة ومنخفضة الكاردناليتي — تتجنّب انفجار التسميات
 * الذي يسبّبه استخدام المسار الخام بمعرّفات (`/api/orders/:id`).
 */
export function handlerLabel(controller: string, handler: string): string {
  return `${controller}.${handler}`;
}

/**
 * §13 — تسمية خطأ Telegram حسب الكود ("أخطاء تيليغرام حسب الكود"). يحصر الكاردناليتي:
 * رمز HTTP رقمي موجب فقط (400/403/429…)، وأي شيء آخر → "unknown" كي لا تتضخّم التسميات
 * برسائل حرة أو قيم غير متوقعة من حدود غير موثوقة.
 */
export function telegramErrorLabel(code: unknown): string {
  if (typeof code === "number" && Number.isInteger(code) && code > 0) return String(code);
  if (typeof code === "string" && /^\d{3}$/.test(code)) return code;
  return "unknown";
}

/** §13 — نتيجة طلب OSRM كتسمية ثنائية ("نسبة نجاح OSRM"). */
export function osrmOutcomeLabel(ok: boolean): string {
  return ok ? "success" : "failure";
}
