import type { DriverStatus, OrderStatus, Service } from "@quickdrop/shared";
import { formatTenantMoney } from "./tenant";

// D5 — المال يصل سلسلة أعداد صحيحة (أصغر وحدة) من الـ API. التنسيق بعملة المستأجر
// (الرمز + المنازل الصحيحة، MYR: /100 → "RM 80.00"؛ SYP: 0 منازل → "SYP 8,000")
// عبر formatTenantMoney — بدل الرقم الخام + "ل.س" المكتوبة يدوياً. الناتج يتضمّن الرمز
// فلا حاجة لإلحاق عملة بعده. للعرض فقط (لا يُستخدم بأي حساب).
export function formatMoney(value: string): string {
  return formatTenantMoney(value);
}

export function minutesSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 60_000));
}

// نوع دالة الترجمة (من useT) — تُمرَّر للمساعدات كي تعمل بلغة الواجهة الحالية.
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

// §10.1 — "آخر موقع منذ متى": الموزّع يقرأ عمراً لا طابعاً زمنياً (مُدوَّل عبر time.*)
export function agoLabel(t: Translate, iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return t("time.dash");
  const m = minutesSince(iso);
  if (m < 1) return t("time.now");
  if (m < 60) return t("time.minAgo", { m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("time.hourMinAgo", { h, m: m % 60 });
  return t("time.dayAgo", { d: Math.floor(h / 24) });
}

// تقريب واجهة فقط: "اليوم" بمنطقة المتصفح — اليوم المالي الرسمي يُحسب خادمياً
// بمنطقة المستأجر (tenantDay — الفخ 8)؛ عمود "منتهية اليوم" عرض لا محاسبة.
export function isToday(iso: string): boolean {
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

// §5 — تسميات الحالات/الخدمات/حالة السائق مُدوَّلة (status.* / service.* / driverStatus.*).
// مرّر t من useT()؛ القيم بالعربية/الإنجليزية/الملايوية في messages.ts.
export function statusLabel(t: Translate, s: OrderStatus): string {
  return t(`status.${s}`);
}
export function serviceLabel(t: Translate, s: Service): string {
  return t(`service.${s}`);
}
export function driverStatusLabel(t: Translate, s: DriverStatus): string {
  return t(`driverStatus.${s}`);
}

// مؤشر الاتصال: وقت آخر تحديث بأرقام لاتينية (tabular-nums على الجذر أصلاً)
export function timeLabel(d: Date): string {
  return d.toLocaleTimeString("ar-u-nu-latn", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
