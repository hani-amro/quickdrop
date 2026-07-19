import type { DriverStatus, OrderStatus, Service } from "@quickdrop/shared";

// D5 + الفخ 1 — المال يصل سلسلة أعداد صحيحة من الـ API؛ التجميع نصّي بحت
// (Number يفقد الدقة فوق 2^53) وفواصل الآلاف للعرض فقط عند الحافة.
export function formatMoney(value: string): string {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  if (!/^\d+$/.test(digits)) return value; // دفاعي: ليس عدداً — أعده كما هو
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}

export function minutesSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 60_000));
}

// §10.1 — "آخر موقع منذ متى": الموزّع يقرأ عمراً لا طابعاً زمنياً
export function agoLabel(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return "—";
  const m = minutesSince(iso);
  if (m < 1) return "الآن";
  if (m < 60) return `منذ ${m} د`;
  const h = Math.floor(m / 60);
  if (h < 24) return `منذ ${h} س ${m % 60} د`;
  return `منذ ${Math.floor(h / 24)} يوم`;
}

// تقريب واجهة فقط: "اليوم" بمنطقة المتصفح — اليوم المالي الرسمي يُحسب خادمياً
// بمنطقة المستأجر (tenantDay — الفخ 8)؛ عمود "منتهية اليوم" عرض لا محاسبة.
export function isToday(iso: string): boolean {
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

// §5 — تسميات الحالات بالعربي (الفخ 13: صيغت عربياً من البداية، لا ترجمة)
export const STATUS_LABELS: Record<OrderStatus, string> = {
  draft: "مسودة",
  scheduled: "مجدول",
  pending: "بانتظار التأكيد",
  confirmed: "بحاجة سائق",
  preparing: "قيد التحضير", // §4.2 — مطبخ (food)
  ready: "جاهز للتوصيل", // §4.2 — مطبخ (food)
  assigned: "أُسند لسائق",
  picked_up: "استُلمت البضاعة",
  in_transit: "بالطريق",
  arrived: "وصل الوجهة",
  delivered: "سُلّم",
  cancelled_by_customer: "ألغاه الزبون",
  cancelled_by_office: "ألغاه المكتب",
  failed: "فشل التوصيل",
  returned: "أُرجع",
};

export const SERVICE_LABELS: Record<Service, string> = {
  food: "توصيل",
  parcel: "طرد",
  p2p: "خاص",
};

export const DRIVER_STATUS_LABELS: Record<DriverStatus, string> = {
  online: "متصل",
  offline: "خارج الوردية",
};

// مؤشر الاتصال: وقت آخر تحديث بأرقام لاتينية (tabular-nums على الجذر أصلاً)
export function timeLabel(d: Date): string {
  return d.toLocaleTimeString("ar-u-nu-latn", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
