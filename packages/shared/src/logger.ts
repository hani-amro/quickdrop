// §13 المراقبة — لوغ منظّم JSON بحقول ثابتة (tenant_id, order_id, actor, action):
// "بدونها لن تحقق بأي شكوى «طلبي اختفى»". §11 — كل سطر يمرّ بـ redactSecrets قبل
// الطباعة (الفخ 15: أسرار باللوغ): توكنات بوت، هواتف E.164، حقول token/password/secret.
// formatLogLine نقية (حتمية) للاختبار؛ log تحقن الطابع الزمني ثم تكتب للتيار المناسب.

import { redactSecrets } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

// الحقول المسماة تُطبع بمفاتيح snake_case القانونية (نفس أسماء §13)؛ أي حقل إضافي
// يمرّ كما هو. كلها `| undefined` صراحةً كي يقبلها exactOptionalPropertyTypes عند
// تمرير قيمة قد تكون undefined (مثلاً job?.id) — والقيم undefined تُسقط من الإخراج.
export interface LogEntry {
  level?: LogLevel | undefined;
  ts?: string | undefined;
  action: string;
  tenantId?: string | undefined;
  orderId?: string | undefined;
  actor?: string | undefined;
  [key: string]: unknown;
}

/**
 * يبني سطر اللوغ النهائي (JSON مُنقّى من الأسرار). حتمي بالكامل — لا ساعة ولا I/O:
 * الطابع الزمني (إن وُجد) يأتي جاهزاً بالمدخل. ترتيب المفاتيح ثابت (level, ts, action,
 * ثم المعرّفات ثم الفاعل ثم الإضافات) لقراءة بشرية متسقة، والقيم undefined تُحذف.
 */
export function formatLogLine(entry: LogEntry): string {
  const { level = "info", ts, action, tenantId, orderId, actor, ...rest } = entry;
  const record: Record<string, unknown> = { level };
  if (ts !== undefined) record.ts = ts;
  record.action = action;
  if (tenantId !== undefined) record.tenant_id = tenantId;
  if (orderId !== undefined) record.order_id = orderId;
  if (actor !== undefined) record.actor = actor;
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) record[key] = value;
  }
  // §11 — التنقية على السلسلة كاملةً: تلتقط الأسرار داخل أي قيمة نصية مهما كان الحقل.
  return redactSecrets(JSON.stringify(record));
}

/**
 * §13 — يكتب سطر لوغ منظّماً. error/warn إلى stderr (console.error/warn)، وغيرها إلى
 * stdout — يحفظ دلالة التيارات القائمة. الطابع الزمني ISO يُحقن هنا (نقطة عدم الحتمية
 * الوحيدة) ما لم يُمرَّر صراحةً.
 */
export function log(entry: LogEntry): void {
  const line = formatLogLine(entry.ts === undefined ? { ...entry, ts: new Date().toISOString() } : entry);
  const level = entry.level ?? "info";
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
